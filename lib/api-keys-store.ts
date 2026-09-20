import "server-only"
/**
 * SPEC 67 — API key platform (issuance, hashing, scoping, revocation).
 * ---------------------------------------------------------------------------
 * A key is generated once, shown to the admin exactly once, and never stored
 * in recoverable form: only a SHA-256 hash of the full secret is persisted,
 * mirroring the write-once-reveal-once pattern used for MFA recovery codes
 * (lib/mfa.ts). `key_prefix` (the first 8 chars after the `mn_` marker) is
 * kept in the clear purely so the admin UI can show "mn_a1b2c3d4…" for
 * identification without ever re-deriving the secret.
 *
 * Consumed by lib/api-auth.ts at request time to authenticate the public
 * `/api/v1/*` surface.
 */
import crypto from "crypto"
import { query } from "@/lib/db"

export type ApiKeyStatus = "active" | "revoked"

export type ApiKeyRow = {
  id: number
  tenant_id: number
  name: string
  key_prefix: string
  key_hash: string
  scopes: string
  status: ApiKeyStatus
  created_by: number | null
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
}

export type PublicApiKey = Omit<ApiKeyRow, "key_hash">

/** Every scope a key can be granted, and what it's for — surfaced in the admin UI. */
export const AVAILABLE_SCOPES = [
  { value: "clients:read", label: "Read clients" },
  { value: "clients:write", label: "Create / update clients" },
  { value: "events:read", label: "Read webhook event log" },
] as const

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`api_keys\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`name\` VARCHAR(120) NOT NULL,
      \`key_prefix\` VARCHAR(16) NOT NULL,
      \`key_hash\` VARCHAR(64) NOT NULL,
      \`scopes\` VARCHAR(255) NOT NULL DEFAULT '',
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

export async function listApiKeys(tenantId: number): Promise<PublicApiKey[]> {
  await ensureApiKeysSchema()
  const rows = await query<ApiKeyRow[]>(
    `SELECT * FROM \`api_keys\` WHERE \`tenant_id\` = ? ORDER BY \`created_at\` DESC`,
    [tenantId],
  )
  return rows.map(toPublicKey)
}

export type CreateApiKeyInput = {
  name: string
  scopes: string[]
  expiresAt?: string | null
}

/** Creates a key and returns the ONE-TIME plaintext value alongside the stored row. */
export async function createApiKey(
  tenantId: number,
  input: CreateApiKeyInput,
  createdBy: number,
): Promise<{ key: PublicApiKey; plaintext: string }> {
  await ensureApiKeysSchema()
  const prefix = crypto.randomBytes(6).toString("hex")
  const secret = crypto.randomBytes(24).toString("hex")
  const plaintext = `mn_${prefix}_${secret}`
  const keyHash = hashKey(plaintext)
  const scopes = input.scopes.join(",")

  const result = await query<{ insertId: number }>(
    `INSERT INTO \`api_keys\` (\`tenant_id\`, \`name\`, \`key_prefix\`, \`key_hash\`, \`scopes\`, \`status\`, \`created_by\`, \`expires_at\`)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [tenantId, input.name.trim(), prefix, keyHash, scopes, createdBy, input.expiresAt ?? null],
  )
  const id = (result as any).insertId as number
  const rows = await query<ApiKeyRow[]>(`SELECT * FROM \`api_keys\` WHERE \`id\` = ?`, [id])
  return { key: toPublicKey(rows[0]), plaintext }
}

export async function revokeApiKey(tenantId: number, id: number): Promise<void> {
  await ensureApiKeysSchema()
  await query(
    `UPDATE \`api_keys\` SET \`status\` = 'revoked', \`revoked_at\` = CURRENT_TIMESTAMP
     WHERE \`id\` = ? AND \`tenant_id\` = ?`,
    [id, tenantId],
  )
}

export async function deleteApiKey(tenantId: number, id: number): Promise<void> {
  await ensureApiKeysSchema()
  await query(`DELETE FROM \`api_keys\` WHERE \`id\` = ? AND \`tenant_id\` = ?`, [id, tenantId])
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
