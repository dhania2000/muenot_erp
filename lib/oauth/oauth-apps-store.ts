import "server-only"
/**
 * Spec 14 — Tenant OAuth applications (developer center).
 * ---------------------------------------------------------------------------
 * A tenant admin registers an OAuth *app* in the developer console and grants
 * it a least-privilege set of scopes (the "scoped consent"). The app then uses
 * the OAuth 2.0 **client credentials** grant (RFC 6749 §4.4) at
 * `POST /api/v1/oauth/token` to exchange its `client_id` + `client_secret` for
 * a short-lived bearer access token. That token authenticates the same public
 * `/api/v1/*` surface as an API key (see lib/api-auth.ts), but:
 *
 *   - the secret is shown ONCE and stored only as a SHA-256 hash (like API keys
 *     and MFA recovery codes) — never in recoverable form;
 *   - the secret is ROTATABLE with an optional overlap window, so a live
 *     integration can roll to a new secret without a hard cutover;
 *   - a token's scopes can only ever be a SUBSET of the app's granted scopes
 *     (least privilege is enforced at issue time, not trusted from the client);
 *   - both apps and individual tokens are independently REVOCABLE, and every
 *     lifecycle action is written to an append-only audit trail.
 *
 * Everything here is tenant-scoped: the acting tenant is derived from the
 * verified session (for console operations) or from the app row itself (for
 * token issuance / verification) — never from client-supplied input.
 */
import crypto from "crypto"
import { query } from "@/lib/db"
import { AVAILABLE_SCOPES } from "@/lib/api-keys-store"

export const OAUTH_SCOPES = AVAILABLE_SCOPES
const VALID_SCOPES = new Set(OAUTH_SCOPES.map((s) => s.value))

/** Default access-token lifetime and the bounds a tenant may configure. */
export const DEFAULT_TOKEN_TTL_SECONDS = 3600
export const MIN_TOKEN_TTL_SECONDS = 300
export const MAX_TOKEN_TTL_SECONDS = 86_400
/** Default overlap window during which a rotated-away secret keeps working. */
export const DEFAULT_ROTATION_GRACE_SECONDS = 3600
export const MAX_ROTATION_GRACE_SECONDS = 604_800 // 7 days

export type OAuthAppStatus = "active" | "revoked"

export type OAuthAppRow = {
  id: number
  tenant_id: number
  name: string
  description: string | null
  client_id: string
  client_secret_hash: string
  secret_hint: string
  prev_secret_hash: string | null
  prev_secret_expires_at: string | null
  scopes: string
  token_ttl_seconds: number
  status: OAuthAppStatus
  created_by: number | null
  created_at: string
  updated_at: string
  last_rotated_at: string | null
  revoked_at: string | null
}

export type PublicOAuthApp = Omit<
  OAuthAppRow,
  "client_secret_hash" | "prev_secret_hash" | "tenant_id"
> & { tenantId: number; scopeList: string[]; secretRotating: boolean }

export type OAuthTokenRow = {
  id: number
  tenant_id: number
  app_id: number
  token_hash: string
  token_prefix: string
  scopes: string
  expires_at: string
  revoked_at: string | null
  created_at: string
  last_used_at: string | null
}

export type PublicOAuthToken = Omit<OAuthTokenRow, "token_hash" | "tenant_id"> & {
  tenantId: number
  scopeList: string[]
  active: boolean
}

export type OAuthEventType =
  | "created"
  | "secret_rotated"
  | "scopes_updated"
  | "revoked"
  | "deleted"
  | "token_issued"
  | "token_revoked"
  | "token_denied"

export type OAuthEventRow = {
  id: number
  tenant_id: number
  app_id: number | null
  event: OAuthEventType
  actor_user_id: number | null
  detail: string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Schema (idempotent, mirrors the runtime-migration pattern used across specs)
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`oauth_apps\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`name\` VARCHAR(120) NOT NULL,
      \`description\` VARCHAR(255) DEFAULT NULL,
      \`client_id\` VARCHAR(64) NOT NULL,
      \`client_secret_hash\` VARCHAR(64) NOT NULL,
      \`secret_hint\` VARCHAR(16) NOT NULL DEFAULT '',
      \`prev_secret_hash\` VARCHAR(64) DEFAULT NULL,
      \`prev_secret_expires_at\` DATETIME DEFAULT NULL,
      \`scopes\` VARCHAR(500) NOT NULL DEFAULT '',
      \`token_ttl_seconds\` INT UNSIGNED NOT NULL DEFAULT 3600,
      \`status\` ENUM('active','revoked') NOT NULL DEFAULT 'active',
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      \`last_rotated_at\` DATETIME DEFAULT NULL,
      \`revoked_at\` DATETIME DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_oauth_apps_client\` (\`client_id\`),
      KEY \`idx_oauth_apps_tenant\` (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS \`oauth_access_tokens\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`app_id\` INT UNSIGNED NOT NULL,
      \`token_hash\` VARCHAR(64) NOT NULL,
      \`token_prefix\` VARCHAR(24) NOT NULL,
      \`scopes\` VARCHAR(500) NOT NULL DEFAULT '',
      \`expires_at\` DATETIME NOT NULL,
      \`revoked_at\` DATETIME DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`last_used_at\` DATETIME DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_oauth_token_hash\` (\`token_hash\`),
      KEY \`idx_oauth_tokens_tenant\` (\`tenant_id\`),
      KEY \`idx_oauth_tokens_app\` (\`app_id\`),
      KEY \`idx_oauth_tokens_expiry\` (\`expires_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS \`oauth_app_events\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`app_id\` INT UNSIGNED DEFAULT NULL,
      \`event\` ENUM('created','secret_rotated','scopes_updated','revoked','deleted','token_issued','token_revoked','token_denied') NOT NULL,
      \`actor_user_id\` INT UNSIGNED DEFAULT NULL,
      \`detail\` VARCHAR(255) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_oauth_events_tenant\` (\`tenant_id\`),
      KEY \`idx_oauth_events_app\` (\`app_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export async function ensureOAuthSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function newClientId(): string {
  return `mnoauth_${crypto.randomBytes(12).toString("hex")}`
}

function newClientSecret(): string {
  return `mnosec_${crypto.randomBytes(24).toString("hex")}`
}

function newAccessToken(): { plaintext: string; prefix: string } {
  const random = crypto.randomBytes(6).toString("hex")
  const prefix = `oat_${random}`
  const plaintext = `mnoat_${prefix}_${crypto.randomBytes(24).toString("hex")}`
  return { plaintext, prefix }
}

/** True when a plaintext value is shaped like one of our OAuth access tokens. */
export function looksLikeOAuthToken(value: string): boolean {
  return value.startsWith("mnoat_")
}

/**
 * Normalize + validate a requested scope list against the allowed set.
 * Deduplicates, drops blanks, and rejects any scope not in `allowed`.
 */
export function narrowScopes(requested: string[], allowed: string[]): { ok: true; scopes: string[] } | { ok: false; invalid: string[] } {
  const allowedSet = new Set(allowed)
  const seen = new Set<string>()
  const out: string[] = []
  const invalid: string[] = []
  for (const raw of requested) {
    const s = raw.trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    if (!allowedSet.has(s)) invalid.push(s)
    else out.push(s)
  }
  if (invalid.length) return { ok: false, invalid }
  return { ok: true, scopes: out }
}

/** Validate that every scope is a known platform scope (least-privilege catalogue). */
function validatePlatformScopes(scopes: string[]): string[] {
  const cleaned = narrowScopes(scopes, [...VALID_SCOPES])
  if (!cleaned.ok) throw new Error(`Invalid scope(s): ${cleaned.invalid.join(", ")}`)
  return cleaned.scopes
}

function splitScopes(raw: string): string[] {
  return raw ? raw.split(",").filter(Boolean) : []
}

export function toPublicApp(row: OAuthAppRow): PublicOAuthApp {
  const { client_secret_hash, prev_secret_hash, tenant_id, ...rest } = row
  return {
    ...rest,
    tenantId: tenant_id,
    scopeList: splitScopes(row.scopes),
    secretRotating: Boolean(prev_secret_hash && row.prev_secret_expires_at && new Date(row.prev_secret_expires_at).getTime() > Date.now()),
  }
}

export function toPublicToken(row: OAuthTokenRow): PublicOAuthToken {
  const { token_hash, tenant_id, ...rest } = row
  const expired = new Date(row.expires_at).getTime() < Date.now()
  return {
    ...rest,
    tenantId: tenant_id,
    scopeList: splitScopes(row.scopes),
    active: !row.revoked_at && !expired,
  }
}

// ---------------------------------------------------------------------------
// App lifecycle (console — tenant-scoped)
// ---------------------------------------------------------------------------

export async function listOAuthApps(tenantId: number): Promise<PublicOAuthApp[]> {
  await ensureOAuthSchema()
  const rows = await query<OAuthAppRow[]>(
    `SELECT * FROM \`oauth_apps\` WHERE \`tenant_id\` = ? ORDER BY \`created_at\` DESC`,
    [tenantId],
  )
  return rows.map(toPublicApp)
}

export async function getOAuthApp(tenantId: number, id: number): Promise<PublicOAuthApp | null> {
  await ensureOAuthSchema()
  const rows = await query<OAuthAppRow[]>(`SELECT * FROM \`oauth_apps\` WHERE \`id\` = ? AND \`tenant_id\` = ? LIMIT 1`, [
    id,
    tenantId,
  ])
  return rows[0] ? toPublicApp(rows[0]) : null
}

export type CreateOAuthAppInput = {
  name: string
  description?: string | null
  scopes: string[]
  tokenTtlSeconds?: number
}

function clampTtl(ttl: number | undefined): number {
  if (!ttl || !Number.isFinite(ttl)) return DEFAULT_TOKEN_TTL_SECONDS
  return Math.min(Math.max(Math.floor(ttl), MIN_TOKEN_TTL_SECONDS), MAX_TOKEN_TTL_SECONDS)
}

/** Registers an app and returns the ONE-TIME client secret alongside the stored row. */
export async function createOAuthApp(
  tenantId: number,
  input: CreateOAuthAppInput,
  createdBy: number,
): Promise<{ app: PublicOAuthApp; clientSecret: string }> {
  await ensureOAuthSchema()
  const name = input.name.trim()
  if (!name) throw new Error("App name is required")
  const scopes = validatePlatformScopes(input.scopes)
  const ttl = clampTtl(input.tokenTtlSeconds)

  const clientId = newClientId()
  const clientSecret = newClientSecret()
  const secretHint = clientSecret.slice(-4)

  const result = await query<{ insertId: number }>(
    `INSERT INTO \`oauth_apps\`
       (\`tenant_id\`, \`name\`, \`description\`, \`client_id\`, \`client_secret_hash\`, \`secret_hint\`, \`scopes\`, \`token_ttl_seconds\`, \`status\`, \`created_by\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [tenantId, name, input.description?.trim() || null, clientId, sha256(clientSecret), secretHint, scopes.join(","), ttl, createdBy],
  )
  const id = (result as any).insertId as number
  await recordOAuthEvent({ tenantId, appId: id, event: "created", actorUserId: createdBy, detail: scopes.join(" ") || "no scopes" })
  const rows = await query<OAuthAppRow[]>(`SELECT * FROM \`oauth_apps\` WHERE \`id\` = ?`, [id])
  return { app: toPublicApp(rows[0]), clientSecret }
}

/**
 * Rotates the client secret. The previous secret keeps working until
 * `graceSeconds` elapses (default 1h, capped at 7d), so a running integration
 * can pick up the new secret without a hard cutover. Returns the one-time value.
 */
export async function rotateOAuthAppSecret(
  tenantId: number,
  id: number,
  actorUserId: number,
  opts: { graceSeconds?: number } = {},
): Promise<{ clientSecret: string; graceSeconds: number } | null> {
  await ensureOAuthSchema()
  const rows = await query<OAuthAppRow[]>(`SELECT * FROM \`oauth_apps\` WHERE \`id\` = ? AND \`tenant_id\` = ? LIMIT 1`, [
    id,
    tenantId,
  ])
  const app = rows[0]
  if (!app) return null

  const grace = Math.min(Math.max(Math.floor(opts.graceSeconds ?? DEFAULT_ROTATION_GRACE_SECONDS), 0), MAX_ROTATION_GRACE_SECONDS)
  const clientSecret = newClientSecret()
  const secretHint = clientSecret.slice(-4)
  const prevExpiry = grace > 0 ? new Date(Date.now() + grace * 1000) : null

  await query(
    `UPDATE \`oauth_apps\`
        SET \`client_secret_hash\` = ?, \`secret_hint\` = ?,
            \`prev_secret_hash\` = ?, \`prev_secret_expires_at\` = ?,
            \`last_rotated_at\` = CURRENT_TIMESTAMP
      WHERE \`id\` = ? AND \`tenant_id\` = ?`,
    [sha256(clientSecret), secretHint, grace > 0 ? app.client_secret_hash : null, prevExpiry, id, tenantId],
  )
  await recordOAuthEvent({
    tenantId,
    appId: id,
    event: "secret_rotated",
    actorUserId,
    detail: grace > 0 ? `old secret valid for ${grace}s` : "immediate cutover",
  })
  return { clientSecret, graceSeconds: grace }
}

export type UpdateOAuthAppInput = {
  name?: string
  description?: string | null
  scopes?: string[]
  tokenTtlSeconds?: number
}

/** Updates registration metadata / scoped consent. Narrowing scopes is the primary knob. */
export async function updateOAuthApp(
  tenantId: number,
  id: number,
  input: UpdateOAuthAppInput,
  actorUserId: number,
): Promise<boolean> {
  await ensureOAuthSchema()
  const sets: string[] = []
  const params: unknown[] = []
  let scopeDetail: string | null = null

  if (input.name !== undefined) {
    const n = input.name.trim()
    if (!n) throw new Error("App name cannot be empty")
    sets.push("`name` = ?")
    params.push(n)
  }
  if (input.description !== undefined) {
    sets.push("`description` = ?")
    params.push(input.description?.trim() || null)
  }
  if (input.scopes !== undefined) {
    const scopes = validatePlatformScopes(input.scopes)
    sets.push("`scopes` = ?")
    params.push(scopes.join(","))
    scopeDetail = scopes.join(" ") || "no scopes"
  }
  if (input.tokenTtlSeconds !== undefined) {
    sets.push("`token_ttl_seconds` = ?")
    params.push(clampTtl(input.tokenTtlSeconds))
  }
  if (sets.length === 0) return false
  params.push(id, tenantId)
  const res = await query<{ affectedRows: number }>(
    `UPDATE \`oauth_apps\` SET ${sets.join(", ")} WHERE \`id\` = ? AND \`tenant_id\` = ?`,
    params,
  )
  const changed = ((res as any).affectedRows ?? 0) > 0
  if (changed && scopeDetail !== null) {
    await recordOAuthEvent({ tenantId, appId: id, event: "scopes_updated", actorUserId, detail: scopeDetail })
  }
  return changed
}

/** Revokes an app AND all of its live tokens in one shot. */
export async function revokeOAuthApp(tenantId: number, id: number, actorUserId: number): Promise<boolean> {
  await ensureOAuthSchema()
  const res = await query<{ affectedRows: number }>(
    `UPDATE \`oauth_apps\` SET \`status\` = 'revoked', \`revoked_at\` = CURRENT_TIMESTAMP WHERE \`id\` = ? AND \`tenant_id\` = ? AND \`status\` = 'active'`,
    [id, tenantId],
  )
  await query(
    `UPDATE \`oauth_access_tokens\` SET \`revoked_at\` = CURRENT_TIMESTAMP WHERE \`app_id\` = ? AND \`tenant_id\` = ? AND \`revoked_at\` IS NULL`,
    [id, tenantId],
  )
  const changed = ((res as any).affectedRows ?? 0) > 0
  if (changed) await recordOAuthEvent({ tenantId, appId: id, event: "revoked", actorUserId })
  return changed
}

export async function deleteOAuthApp(tenantId: number, id: number, actorUserId: number): Promise<void> {
  await ensureOAuthSchema()
  await query(`DELETE FROM \`oauth_access_tokens\` WHERE \`app_id\` = ? AND \`tenant_id\` = ?`, [id, tenantId])
  await query(`DELETE FROM \`oauth_apps\` WHERE \`id\` = ? AND \`tenant_id\` = ?`, [id, tenantId])
  await recordOAuthEvent({ tenantId, appId: id, event: "deleted", actorUserId })
}

// ---------------------------------------------------------------------------
// Token issuance + verification (client credentials grant)
// ---------------------------------------------------------------------------

export type IssueTokenResult =
  | {
      ok: true
      accessToken: string
      tokenType: "Bearer"
      expiresIn: number
      scope: string
      tenantId: number
      appId: number
    }
  | { ok: false; error: "invalid_client" | "invalid_scope" | "app_revoked"; detail?: string }

/**
 * Client-credentials grant. Verifies the client_id/secret pair (accepting a
 * within-grace previous secret), enforces that requested scopes are a subset of
 * the app's granted scopes, then mints + persists a hashed access token.
 *
 * Fails closed and UNIFORMLY for any credential problem (`invalid_client`) so a
 * caller cannot distinguish "unknown client" from "wrong secret".
 */
export async function issueClientCredentialsToken(input: {
  clientId: string
  clientSecret: string
  requestedScopes?: string[]
}): Promise<IssueTokenResult> {
  await ensureOAuthSchema()
  const clientId = (input.clientId || "").trim()
  const clientSecret = (input.clientSecret || "").trim()
  if (!clientId || !clientSecret) return { ok: false, error: "invalid_client" }

  const rows = await query<OAuthAppRow[]>(`SELECT * FROM \`oauth_apps\` WHERE \`client_id\` = ? LIMIT 1`, [clientId])
  const app = rows[0]
  if (!app) return { ok: false, error: "invalid_client" }

  if (app.status !== "active") {
    await recordOAuthEvent({ tenantId: app.tenant_id, appId: app.id, event: "token_denied", detail: "app_revoked" })
    return { ok: false, error: "app_revoked" }
  }

  const presented = sha256(clientSecret)
  const currentOk = crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(app.client_secret_hash))
  const prevOk =
    !currentOk &&
    Boolean(app.prev_secret_hash) &&
    Boolean(app.prev_secret_expires_at) &&
    new Date(app.prev_secret_expires_at as string).getTime() > Date.now() &&
    crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(app.prev_secret_hash as string))
  if (!currentOk && !prevOk) {
    await recordOAuthEvent({ tenantId: app.tenant_id, appId: app.id, event: "token_denied", detail: "invalid_secret" })
    return { ok: false, error: "invalid_client" }
  }

  const granted = splitScopes(app.scopes)
  let scopes: string[]
  if (input.requestedScopes && input.requestedScopes.length > 0) {
    const narrowed = narrowScopes(input.requestedScopes, granted)
    if (!narrowed.ok) {
      await recordOAuthEvent({ tenantId: app.tenant_id, appId: app.id, event: "token_denied", detail: `invalid_scope: ${narrowed.invalid.join(" ")}` })
      return { ok: false, error: "invalid_scope", detail: narrowed.invalid.join(" ") }
    }
    scopes = narrowed.scopes
  } else {
    // No scope param → grant the app's full consented set (still least-privilege
    // relative to the platform, because the app itself was granted a subset).
    scopes = granted
  }

  const ttl = clampTtl(app.token_ttl_seconds)
  const { plaintext, prefix } = newAccessToken()
  const expiresAt = new Date(Date.now() + ttl * 1000)
  await query(
    `INSERT INTO \`oauth_access_tokens\`
       (\`tenant_id\`, \`app_id\`, \`token_hash\`, \`token_prefix\`, \`scopes\`, \`expires_at\`)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [app.tenant_id, app.id, sha256(plaintext), prefix, scopes.join(","), expiresAt],
  )
  await recordOAuthEvent({ tenantId: app.tenant_id, appId: app.id, event: "token_issued", detail: scopes.join(" ") || "no scopes" })

  return {
    ok: true,
    accessToken: plaintext,
    tokenType: "Bearer",
    expiresIn: ttl,
    scope: scopes.join(" "),
    tenantId: app.tenant_id,
    appId: app.id,
  }
}

export type VerifiedOAuthToken = {
  tokenId: number
  appId: number
  tenantId: number
  scopes: string[]
  appName: string
}

export type VerifyTokenResult =
  | { ok: true; token: VerifiedOAuthToken }
  | { ok: false; reason: "unknown" | "revoked" | "expired" | "app_revoked" }

/**
 * Verifies a bearer access token for the public API. Fails closed with a
 * distinct reason for the audit trail; the caller collapses all of them to 401.
 * The token's tenant is taken from the stored row — never from request input —
 * which is what makes cross-tenant access impossible by construction.
 */
export async function verifyOAuthAccessToken(plaintext: string): Promise<VerifyTokenResult> {
  if (!looksLikeOAuthToken(plaintext)) return { ok: false, reason: "unknown" }
  await ensureOAuthSchema()
  const rows = await query<Array<OAuthTokenRow & { app_status: OAuthAppStatus; app_name: string }>>(
    `SELECT t.*, a.\`status\` AS app_status, a.\`name\` AS app_name
       FROM \`oauth_access_tokens\` t
       JOIN \`oauth_apps\` a ON a.\`id\` = t.\`app_id\`
      WHERE t.\`token_hash\` = ? LIMIT 1`,
    [sha256(plaintext)],
  )
  const row = rows[0]
  if (!row) return { ok: false, reason: "unknown" }
  if (row.revoked_at) return { ok: false, reason: "revoked" }
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" }
  if (row.app_status !== "active") return { ok: false, reason: "app_revoked" }

  void query(`UPDATE \`oauth_access_tokens\` SET \`last_used_at\` = CURRENT_TIMESTAMP WHERE \`id\` = ?`, [row.id]).catch(
    () => {},
  )
  return {
    ok: true,
    token: {
      tokenId: row.id,
      appId: row.app_id,
      tenantId: row.tenant_id,
      scopes: splitScopes(row.scopes),
      appName: row.app_name,
    },
  }
}

export async function listOAuthTokens(tenantId: number, appId: number, limit = 50): Promise<PublicOAuthToken[]> {
  await ensureOAuthSchema()
  const capped = Math.min(Math.max(limit, 1), 200)
  const rows = await query<OAuthTokenRow[]>(
    `SELECT * FROM \`oauth_access_tokens\` WHERE \`tenant_id\` = ? AND \`app_id\` = ? ORDER BY \`created_at\` DESC LIMIT ?`,
    [tenantId, appId, capped],
  )
  return rows.map(toPublicToken)
}

export async function revokeOAuthToken(tenantId: number, appId: number, tokenId: number, actorUserId: number): Promise<boolean> {
  await ensureOAuthSchema()
  const res = await query<{ affectedRows: number }>(
    `UPDATE \`oauth_access_tokens\` SET \`revoked_at\` = CURRENT_TIMESTAMP
      WHERE \`id\` = ? AND \`app_id\` = ? AND \`tenant_id\` = ? AND \`revoked_at\` IS NULL`,
    [tokenId, appId, tenantId],
  )
  const changed = ((res as any).affectedRows ?? 0) > 0
  if (changed) await recordOAuthEvent({ tenantId, appId, event: "token_revoked", actorUserId, detail: `token #${tokenId}` })
  return changed
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export async function recordOAuthEvent(input: {
  tenantId: number
  appId: number | null
  event: OAuthEventType
  actorUserId?: number | null
  detail?: string | null
}): Promise<void> {
  try {
    await ensureOAuthSchema()
    await query(
      `INSERT INTO \`oauth_app_events\` (\`tenant_id\`, \`app_id\`, \`event\`, \`actor_user_id\`, \`detail\`)
       VALUES (?, ?, ?, ?, ?)`,
      [input.tenantId, input.appId, input.event, input.actorUserId ?? null, input.detail ?? null],
    )
  } catch {
    // best-effort — auditing never breaks the primary operation
  }
}

export async function listOAuthEvents(
  tenantId: number,
  opts: { appId?: number; limit?: number } = {},
): Promise<OAuthEventRow[]> {
  await ensureOAuthSchema()
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  if (opts.appId != null) {
    return query<OAuthEventRow[]>(
      `SELECT * FROM \`oauth_app_events\` WHERE \`tenant_id\` = ? AND \`app_id\` = ? ORDER BY \`created_at\` DESC LIMIT ?`,
      [tenantId, opts.appId, limit],
    )
  }
  return query<OAuthEventRow[]>(
    `SELECT * FROM \`oauth_app_events\` WHERE \`tenant_id\` = ? ORDER BY \`created_at\` DESC LIMIT ?`,
    [tenantId, limit],
  )
}
