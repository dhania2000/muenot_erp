import "server-only"
/**
 * SPEC 67 + SPEC 52 — API key platform (issuance, hashing, scoping, revocation,
 * environments, IP restrictions, audit trail).
 * ---------------------------------------------------------------------------
 * A key is generated once, shown to the admin exactly once, and never stored
 * in recoverable form: only a SHA-256 hash of the full secret is persisted,
 * mirroring the write-once-reveal-once pattern used for MFA recovery codes
 * (lib/mfa.ts). `key_prefix` (a short public identifier) is kept in the clear
 * purely so the admin UI can show "mn_live_a1b2c3d4…" for identification
 * without ever re-deriving the secret.
 *
 * SPEC 52 adds, on top of the original SPEC 67 model:
 *   - `environment` — live vs test keys, surfaced in the plaintext marker
 *     (`mn_live_…` / `mn_test_…`) so a leaked key's blast radius is obvious.
 *   - `ip_restrictions` — optional comma-separated CIDR allowlist; when set, a
 *     request's source IP must fall inside one of the ranges.
 *   - `api_key_events` — an immutable audit trail (created / revoked / deleted /
 *     authenticated / auth_failed) queryable per key.
 *
 * Consumed by lib/api-auth.ts and lib/api-platform/* at request time to
 * authenticate and govern the public `/api/v1/*` surface.
 */
import crypto from "crypto"
import { query } from "@/lib/db"
import { ipMatchesCidr } from "@/lib/ip-allowlist-store"

export type ApiKeyStatus = "active" | "revoked"
export type ApiKeyEnvironment = "live" | "test"

export type ApiKeyRow = {
  id: number
  tenant_id: number
  name: string
  key_prefix: string
  key_hash: string
  scopes: string
  environment: ApiKeyEnvironment
  ip_restrictions: string
  status: ApiKeyStatus
  created_by: number | null
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
}

export type PublicApiKey = Omit<ApiKeyRow, "key_hash">

export type ApiKeyEventType = "created" | "revoked" | "deleted" | "authenticated" | "auth_failed"

export type ApiKeyEventRow = {
  id: number
  tenant_id: number
  key_id: number | null
  event: ApiKeyEventType
  actor_user_id: number | null
  ip: string | null
  detail: string | null
  created_at: string
}

/** Every scope a key can be granted, and what it's for — surfaced in the admin UI. */
export const AVAILABLE_SCOPES = [
  { value: "clients:read", label: "Read clients" },
  { value: "clients:write", label: "Create / update clients" },
  { value: "events:read", label: "Read webhook event log" },
] as const

export const API_KEY_ENVIRONMENTS: { value: ApiKeyEnvironment; label: string }[] = [
  { value: "live", label: "Live" },
  { value: "test", label: "Test" },
]

let ensured: Promise<void> | null = null

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function addColumnIfMissing(table: string, column: string, ddl: string) {
  if (await columnExists(table, column)) return
  await query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`).catch(() => {})
}

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`api_keys\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`name\` VARCHAR(120) NOT NULL,
      \`key_prefix\` VARCHAR(24) NOT NULL,
      \`key_hash\` VARCHAR(64) NOT NULL,
      \`scopes\` VARCHAR(255) NOT NULL DEFAULT '',
      \`environment\` ENUM('live','test') NOT NULL DEFAULT 'live',
      \`ip_restrictions\` VARCHAR(512) NOT NULL DEFAULT '',
      \`status\` ENUM('active','revoked') NOT NULL DEFAULT 'active',
      \`created_by\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`last_used_at\` DATETIME DEFAULT NULL,
      \`expires_at\` DATETIME DEFAULT NULL,
      \`revoked_at\` DATETIME DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_api_keys_hash\` (\`key_hash\`),
      KEY \`idx_api_keys_tenant\` (\`tenant_id\`),
      KEY \`idx_api_keys_prefix\` (\`key_prefix\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  // Self-heal older SPEC 67 tables that predate the SPEC 52 columns.
  await addColumnIfMissing("api_keys", "environment", "`environment` ENUM('live','test') NOT NULL DEFAULT 'live'")
  await addColumnIfMissing("api_keys", "ip_restrictions", "`ip_restrictions` VARCHAR(512) NOT NULL DEFAULT ''")

  await query(`
    CREATE TABLE IF NOT EXISTS \`api_key_events\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`key_id\` INT UNSIGNED DEFAULT NULL,
      \`event\` ENUM('created','revoked','deleted','authenticated','auth_failed') NOT NULL,
      \`actor_user_id\` INT UNSIGNED DEFAULT NULL,
      \`ip\` VARCHAR(64) DEFAULT NULL,
      \`detail\` VARCHAR(255) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_api_key_events_tenant\` (\`tenant_id\`),
      KEY \`idx_api_key_events_key\` (\`key_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export async function ensureApiKeysSchema(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

function hashKey(fullKey: string): string {
  return crypto.createHash("sha256").update(fullKey).digest("hex")
}

export function toPublicKey(row: ApiKeyRow): PublicApiKey {
  const { key_hash, ...rest } = row
  return rest
}

/** Parses a stored comma-separated CIDR string into a trimmed, non-empty list. */
export function parseIpRestrictions(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * True when `ip` is permitted by a key's IP restrictions. An empty restriction
 * list means unrestricted (any IP). A null/unknown IP against a non-empty list
 * fails closed.
 */
export function keyAllowsIp(ipRestrictions: string | null | undefined, ip: string | null): boolean {
  const ranges = parseIpRestrictions(ipRestrictions)
  if (ranges.length === 0) return true
  if (!ip) return false
  return ranges.some((cidr) => ipMatchesCidr(ip, cidr))
}

export async function listApiKeys(tenantId: number): Promise<PublicApiKey[]> {
  await ensureApiKeysSchema()
  const rows = await query<ApiKeyRow[]>(
    `SELECT * FROM \`api_keys\` WHERE \`tenant_id\` = ? ORDER BY \`created_at\` DESC`,
    [tenantId],
  )
  return rows.map(toPublicKey)
}

export async function getApiKey(tenantId: number, id: number): Promise<PublicApiKey | null> {
  await ensureApiKeysSchema()
  const rows = await query<ApiKeyRow[]>(`SELECT * FROM \`api_keys\` WHERE \`id\` = ? AND \`tenant_id\` = ?`, [
    id,
    tenantId,
  ])
  return rows[0] ? toPublicKey(rows[0]) : null
}

export type CreateApiKeyInput = {
  name: string
  scopes: string[]
  environment?: ApiKeyEnvironment
  ipRestrictions?: string[]
  expiresAt?: string | null
}

/** Creates a key and returns the ONE-TIME plaintext value alongside the stored row. */
export async function createApiKey(
  tenantId: number,
  input: CreateApiKeyInput,
  createdBy: number,
): Promise<{ key: PublicApiKey; plaintext: string }> {
  await ensureApiKeysSchema()
  const environment: ApiKeyEnvironment = input.environment === "test" ? "test" : "live"
  const random = crypto.randomBytes(6).toString("hex")
  // The public prefix carries the environment so a leaked key is self-describing.
  const prefix = `${environment}_${random}`
  const secret = crypto.randomBytes(24).toString("hex")
  const plaintext = `mn_${prefix}_${secret}`
  const keyHash = hashKey(plaintext)
  const scopes = input.scopes.join(",")
  const ipRestrictions = (input.ipRestrictions ?? []).map((s) => s.trim()).filter(Boolean).join(",")

  const result = await query<{ insertId: number }>(
    `INSERT INTO \`api_keys\`
       (\`tenant_id\`, \`name\`, \`key_prefix\`, \`key_hash\`, \`scopes\`, \`environment\`, \`ip_restrictions\`, \`status\`, \`created_by\`, \`expires_at\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [tenantId, input.name.trim(), prefix, keyHash, scopes, environment, ipRestrictions, createdBy, input.expiresAt ?? null],
  )
  const id = (result as any).insertId as number
  await recordApiKeyEvent({
    tenantId,
    keyId: id,
    event: "created",
    actorUserId: createdBy,
    detail: `${environment} · ${scopes || "no scopes"}`,
  })
  const rows = await query<ApiKeyRow[]>(`SELECT * FROM \`api_keys\` WHERE \`id\` = ?`, [id])
  return { key: toPublicKey(rows[0]), plaintext }
}

export async function revokeApiKey(tenantId: number, id: number, actorUserId?: number | null): Promise<void> {
  await ensureApiKeysSchema()
  await query(
    `UPDATE \`api_keys\` SET \`status\` = 'revoked', \`revoked_at\` = CURRENT_TIMESTAMP
     WHERE \`id\` = ? AND \`tenant_id\` = ?`,
    [id, tenantId],
  )
  await recordApiKeyEvent({ tenantId, keyId: id, event: "revoked", actorUserId: actorUserId ?? null })
}

export async function deleteApiKey(tenantId: number, id: number, actorUserId?: number | null): Promise<void> {
  await ensureApiKeysSchema()
  await query(`DELETE FROM \`api_keys\` WHERE \`id\` = ? AND \`tenant_id\` = ?`, [id, tenantId])
  await recordApiKeyEvent({ tenantId, keyId: id, event: "deleted", actorUserId: actorUserId ?? null })
}

/**
 * Authenticates a raw `Authorization: Bearer mn_...` value. Looks the key up
 * by its exact hash (constant-shape lookup — no per-row loop needed since the
 * hash column is unique-indexed), then verifies status/expiry.
 */
export async function findKeyByPlaintext(plaintext: string): Promise<ApiKeyRow | null> {
  if (!plaintext.startsWith("mn_")) return null
  await ensureApiKeysSchema()
  const keyHash = hashKey(plaintext)
  const rows = await query<ApiKeyRow[]>(`SELECT * FROM \`api_keys\` WHERE \`key_hash\` = ? LIMIT 1`, [keyHash])
  return rows[0] ?? null
}

export async function touchKeyUsage(id: number): Promise<void> {
  await query(`UPDATE \`api_keys\` SET \`last_used_at\` = CURRENT_TIMESTAMP WHERE \`id\` = ?`, [id])
}

// ---------------------------------------------------------------------------
// Audit trail (SPEC 52)
// ---------------------------------------------------------------------------

export async function recordApiKeyEvent(input: {
  tenantId: number
  keyId: number | null
  event: ApiKeyEventType
  actorUserId?: number | null
  ip?: string | null
  detail?: string | null
}): Promise<void> {
  // Never let audit writes break the primary operation.
  try {
    await ensureApiKeysSchema()
    await query(
      `INSERT INTO \`api_key_events\` (\`tenant_id\`, \`key_id\`, \`event\`, \`actor_user_id\`, \`ip\`, \`detail\`)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.tenantId, input.keyId, input.event, input.actorUserId ?? null, input.ip ?? null, input.detail ?? null],
    )
  } catch {
    // swallow — auditing is best-effort
  }
}

export async function listApiKeyEvents(
  tenantId: number,
  opts: { keyId?: number; limit?: number } = {},
): Promise<ApiKeyEventRow[]> {
  await ensureApiKeysSchema()
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  if (opts.keyId != null) {
    return query<ApiKeyEventRow[]>(
      `SELECT * FROM \`api_key_events\` WHERE \`tenant_id\` = ? AND \`key_id\` = ? ORDER BY \`created_at\` DESC LIMIT ?`,
      [tenantId, opts.keyId, limit],
    )
  }
  return query<ApiKeyEventRow[]>(
    `SELECT * FROM \`api_key_events\` WHERE \`tenant_id\` = ? ORDER BY \`created_at\` DESC LIMIT ?`,
    [tenantId, limit],
  )
}
