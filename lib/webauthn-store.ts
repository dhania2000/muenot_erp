import "server-only"
/**
 * WebAuthn security-key persistence: challenges, credentials and lockout.
 * ---------------------------------------------------------------------------
 * The pure ceremony maths live in lib/webauthn/*; this module owns the stateful
 * guarantees that make them phishing-resistant in production:
 *
 *   - Challenges are single-use and bound to (user, tenant, origin, rpId,
 *     purpose) with a short expiry. `consumeChallenge` deletes the row in the
 *     same atomic statement it reads it, so a cloned/replayed challenge can
 *     only ever be spent once.
 *   - Credentials are stored per user AND per tenant; every lookup is scoped by
 *     both, which is the cross-tenant defense — one tenant's key can never
 *     authenticate against another tenant.
 *   - Per-user authentication failures are counted with a sliding lockout so a
 *     brute-force / cloned-key probe is stopped after a threshold.
 *
 * Self-heals at runtime (same pattern as lib/session-store.ts) so existing
 * databases converge without a manual migration step; a checked-in migration
 * also exists for operators who apply schema out of band.
 */
import { randomBytes, createHash } from "node:crypto"
import { query } from "@/lib/db"
import type { StoredPublicKey } from "@/lib/webauthn/cose"

export type ChallengePurpose = "register" | "authenticate"

const CHALLENGE_TTL_MS = 5 * 60 * 1000 // 5 minutes (WebAuthn UX budget)
const LOCKOUT_THRESHOLD = 5
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`webauthn_credentials\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`user_id\` INT UNSIGNED NOT NULL,
      \`credential_id\` VARCHAR(255) NOT NULL,
      \`public_key\` TEXT NOT NULL,
      \`sign_count\` BIGINT UNSIGNED NOT NULL DEFAULT 0,
      \`transports\` VARCHAR(255) DEFAULT NULL,
      \`label\` VARCHAR(120) DEFAULT NULL,
      \`backed_up\` TINYINT(1) NOT NULL DEFAULT 0,
      \`aaguid\` VARCHAR(64) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`last_used_at\` TIMESTAMP NULL DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_webauthn_credential_id\` (\`credential_id\`),
      KEY \`idx_webauthn_user\` (\`tenant_id\`, \`user_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS \`webauthn_challenges\` (
      \`id\` VARCHAR(64) NOT NULL,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`user_id\` INT UNSIGNED NOT NULL,
      \`purpose\` ENUM('register','authenticate') NOT NULL,
      \`challenge\` VARCHAR(255) NOT NULL,
      \`origin\` VARCHAR(255) NOT NULL,
      \`rp_id\` VARCHAR(255) NOT NULL,
      \`expires_at\` DATETIME NOT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_webauthn_challenge_user\` (\`tenant_id\`, \`user_id\`, \`purpose\`),
      KEY \`idx_webauthn_challenge_expiry\` (\`expires_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS \`webauthn_auth_failures\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`user_id\` INT UNSIGNED NOT NULL,
      \`reason\` VARCHAR(64) NOT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_webauthn_failures\` (\`tenant_id\`, \`user_id\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export function ensureWebAuthnSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

// ---------------------------------------------------------------------------
// Challenges (bound to user, tenant, origin, rpId, purpose + expiry)
// ---------------------------------------------------------------------------

export type IssuedChallenge = { id: string; challenge: string; expiresAt: number }

/**
 * Issue a fresh single-use challenge. Any older un-consumed challenge for the
 * same (user, purpose) is deleted first so at most one is ever live — this
 * prevents a stockpile of valid challenges an attacker could try to replay.
 */
export async function issueChallenge(input: {
  tenantId: number
  userId: number
  purpose: ChallengePurpose
  origin: string
  rpId: string
}): Promise<IssuedChallenge> {
  await ensureWebAuthnSchema()
  await purgeExpiredChallenges()
  const id = randomBytes(24).toString("base64url")
  const challenge = randomBytes(32).toString("base64url")
  const expiresAt = Date.now() + CHALLENGE_TTL_MS
  await query(
    "DELETE FROM `webauthn_challenges` WHERE tenant_id = ? AND user_id = ? AND purpose = ?",
    [input.tenantId, input.userId, input.purpose],
  )
  await query(
    `INSERT INTO \`webauthn_challenges\`
       (id, tenant_id, user_id, purpose, challenge, origin, rp_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))`,
    [id, input.tenantId, input.userId, input.purpose, challenge, input.origin, input.rpId, Math.floor(expiresAt / 1000)],
  )
  return { id, challenge, expiresAt }
}

export type ConsumedChallenge = {
  challenge: string
  origin: string
  rpId: string
  userId: number
  tenantId: number
}

/**
 * Atomically consume a challenge: verify it exists for this exact
 * (id, user, tenant, purpose), is unexpired, then DELETE it. Because the delete
 * is gated on the same predicate and reports affectedRows, two concurrent
 * consumptions of one challenge cannot both succeed — the second sees
 * affectedRows === 0 and is rejected. Returns null on any miss (unknown,
 * expired, wrong user/tenant, or already spent) so replay fails closed.
 */
export async function consumeChallenge(input: {
  id: string
  tenantId: number
  userId: number
  purpose: ChallengePurpose
}): Promise<ConsumedChallenge | null> {
  await ensureWebAuthnSchema()
  const rows = await query<
    { challenge: string; origin: string; rp_id: string; expires_at: string }[]
  >(
    `SELECT challenge, origin, rp_id, expires_at FROM \`webauthn_challenges\`
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND purpose = ?`,
    [input.id, input.tenantId, input.userId, input.purpose],
  )
  if (rows.length === 0) return null
  const row = rows[0]

  // Delete first (gated on the same identity) — the winner of a race is the
  // caller that actually removed the row.
  const del = await query<{ affectedRows: number }>(
    `DELETE FROM \`webauthn_challenges\`
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND purpose = ?`,
    [input.id, input.tenantId, input.userId, input.purpose],
  )
  if (!del || del.affectedRows !== 1) return null

  if (new Date(row.expires_at).getTime() < Date.now()) return null

  return {
    challenge: row.challenge,
    origin: row.origin,
    rpId: row.rp_id,
    userId: input.userId,
    tenantId: input.tenantId,
  }
}

async function purgeExpiredChallenges(): Promise<void> {
  try {
    await query("DELETE FROM `webauthn_challenges` WHERE expires_at < NOW()")
  } catch {
    // best-effort housekeeping; never blocks issuing a new challenge.
  }
}

// ---------------------------------------------------------------------------
// Credentials (scoped by tenant + user)
// ---------------------------------------------------------------------------

export type WebAuthnCredential = {
  id: number
  credentialId: string
  publicKey: StoredPublicKey
  signCount: number
  transports: string[]
  label: string | null
  backedUp: boolean
  createdAt: string
  lastUsedAt: string | null
}

type CredentialRow = {
  id: number
  credential_id: string
  public_key: string
  sign_count: number
  transports: string | null
  label: string | null
  backed_up: number
  created_at: string
  last_used_at: string | null
}

function toCredential(row: CredentialRow): WebAuthnCredential {
  let publicKey: StoredPublicKey
  try {
    publicKey = JSON.parse(row.public_key)
  } catch {
    publicKey = { alg: 0, jwk: {} }
  }
  return {
    id: row.id,
    credentialId: row.credential_id,
    publicKey,
    signCount: Number(row.sign_count),
    transports: row.transports ? row.transports.split(",").filter(Boolean) : [],
    label: row.label,
    backedUp: Boolean(row.backed_up),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }
}

export async function listCredentials(tenantId: number, userId: number): Promise<WebAuthnCredential[]> {
  await ensureWebAuthnSchema()
  const rows = await query<CredentialRow[]>(
    "SELECT * FROM `webauthn_credentials` WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC",
    [tenantId, userId],
  )
  return rows.map(toCredential)
}

export async function countCredentials(tenantId: number, userId: number): Promise<number> {
  await ensureWebAuthnSchema()
  const rows = await query<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM `webauthn_credentials` WHERE tenant_id = ? AND user_id = ?",
    [tenantId, userId],
  )
  return Number(rows[0]?.n ?? 0)
}

/** Look up ONE credential scoped to the owning user+tenant. Returns null when
 * the credential id belongs to another user/tenant — the cross-tenant guard. */
export async function findCredential(
  tenantId: number,
  userId: number,
  credentialId: string,
): Promise<WebAuthnCredential | null> {
  await ensureWebAuthnSchema()
  const rows = await query<CredentialRow[]>(
    "SELECT * FROM `webauthn_credentials` WHERE tenant_id = ? AND user_id = ? AND credential_id = ? LIMIT 1",
    [tenantId, userId, credentialId],
  )
  return rows.length ? toCredential(rows[0]) : null
}

/** Look up ONE credential by its DB row id, scoped to the owning user+tenant.
 * Returns null when the id belongs to another user/tenant — the cross-tenant
 * guard for revocation by row id. */
export async function getCredentialById(
  tenantId: number,
  userId: number,
  credentialDbId: number,
): Promise<WebAuthnCredential | null> {
  await ensureWebAuthnSchema()
  const rows = await query<CredentialRow[]>(
    "SELECT * FROM `webauthn_credentials` WHERE id = ? AND tenant_id = ? AND user_id = ? LIMIT 1",
    [credentialDbId, tenantId, userId],
  )
  return rows.length ? toCredential(rows[0]) : null
}

export async function saveCredential(input: {
  tenantId: number
  userId: number
  credentialId: string
  publicKey: StoredPublicKey
  signCount: number
  transports: string[]
  label: string | null
  backedUp: boolean
}): Promise<{ ok: true } | { ok: false; reason: "duplicate" }> {
  await ensureWebAuthnSchema()
  // A credential id is globally unique to one authenticator; if it already
  // exists (even under another user) registration must not silently rebind it.
  const existing = await query<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM `webauthn_credentials` WHERE credential_id = ?",
    [input.credentialId],
  )
  if (Number(existing[0]?.n ?? 0) > 0) return { ok: false, reason: "duplicate" }
  await query(
    `INSERT INTO \`webauthn_credentials\`
       (tenant_id, user_id, credential_id, public_key, sign_count, transports, label, backed_up)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.tenantId,
      input.userId,
      input.credentialId,
      JSON.stringify(input.publicKey),
      input.signCount,
      input.transports.join(",").slice(0, 255) || null,
      input.label ? input.label.slice(0, 120) : null,
      input.backedUp ? 1 : 0,
    ],
  )
  return { ok: true }
}

/** Advance the stored signature counter and stamp last use after a successful
 * assertion. Scoped by tenant+user so it can never touch another tenant's row. */
export async function updateCredentialUsage(
  tenantId: number,
  userId: number,
  credentialId: string,
  newSignCount: number,
): Promise<void> {
  await ensureWebAuthnSchema()
  await query(
    "UPDATE `webauthn_credentials` SET sign_count = ?, last_used_at = NOW() WHERE tenant_id = ? AND user_id = ? AND credential_id = ?",
    [newSignCount, tenantId, userId, credentialId],
  )
}

/** Revoke one credential the acting user/admin owns. Returns whether a row was
 * actually removed (so the caller can 404 an id outside the tenant/user). */
export async function revokeCredential(tenantId: number, userId: number, credentialDbId: number): Promise<boolean> {
  await ensureWebAuthnSchema()
  const res = await query<{ affectedRows: number }>(
    "DELETE FROM `webauthn_credentials` WHERE id = ? AND tenant_id = ? AND user_id = ?",
    [credentialDbId, tenantId, userId],
  )
  return Boolean(res && res.affectedRows > 0)
}

/** Admin control: wipe every passkey for a user in a tenant (recovery / reset). */
export async function revokeAllCredentials(tenantId: number, userId: number): Promise<number> {
  await ensureWebAuthnSchema()
  const res = await query<{ affectedRows: number }>(
    "DELETE FROM `webauthn_credentials` WHERE tenant_id = ? AND user_id = ?",
    [tenantId, userId],
  )
  return res?.affectedRows ?? 0
}

// ---------------------------------------------------------------------------
// Per-user authentication lockout
// ---------------------------------------------------------------------------

/** True when the user has hit the failure threshold inside the sliding window. */
export async function isLockedOut(tenantId: number, userId: number): Promise<boolean> {
  await ensureWebAuthnSchema()
  const rows = await query<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM `webauthn_auth_failures` WHERE tenant_id = ? AND user_id = ? AND created_at > (NOW() - INTERVAL ? SECOND)",
    [tenantId, userId, Math.floor(LOCKOUT_WINDOW_MS / 1000)],
  )
  return Number(rows[0]?.n ?? 0) >= LOCKOUT_THRESHOLD
}

export async function recordAuthFailure(tenantId: number, userId: number, reason: string): Promise<void> {
  await ensureWebAuthnSchema()
  try {
    await query(
      "INSERT INTO `webauthn_auth_failures` (tenant_id, user_id, reason) VALUES (?, ?, ?)",
      [tenantId, userId, reason.slice(0, 64)],
    )
  } catch {
    // never let failure accounting block the response
  }
}

export async function clearAuthFailures(tenantId: number, userId: number): Promise<void> {
  await ensureWebAuthnSchema()
  try {
    await query("DELETE FROM `webauthn_auth_failures` WHERE tenant_id = ? AND user_id = ?", [tenantId, userId])
  } catch {
    // best-effort
  }
}

export const WEBAUTHN_LOCKOUT_THRESHOLD = LOCKOUT_THRESHOLD

/** Stable short fingerprint used only for audit correlation (never secret). */
export function credentialFingerprint(credentialId: string): string {
  return createHash("sha256").update(credentialId).digest("hex").slice(0, 12)
}
