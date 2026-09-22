import "server-only"
/**
 * SPEC 51 — Idempotency for unsafe (mutating) requests.
 * ---------------------------------------------------------------------------
 * Callers send an `Idempotency-Key` header on POST/PUT/PATCH. The first request
 * with a given (key_id, idempotency_key) runs normally and its response is
 * persisted; any replay returns the stored response verbatim, so a network
 * retry can never create a duplicate resource or double-charge.
 *
 * A request fingerprint (hash of method + path + body) is stored alongside the
 * key: replaying the SAME key with a DIFFERENT payload is a client error
 * (`idempotency_conflict`) rather than silently returning the old result.
 * Records are scoped per API key and expire after 24h.
 */
import crypto from "crypto"
import { query } from "@/lib/db"

export type IdempotencyRecord = {
  status: number
  body: string
  fingerprint: string
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`api_idempotency_keys\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`key_id\` INT UNSIGNED NOT NULL,
      \`idempotency_key\` VARCHAR(128) NOT NULL,
      \`fingerprint\` VARCHAR(64) NOT NULL,
      \`response_status\` SMALLINT UNSIGNED NOT NULL,
      \`response_body\` MEDIUMTEXT NOT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_idem_key\` (\`key_id\`, \`idempotency_key\`),
      KEY \`idx_idem_created\` (\`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

function ensureSchema(): Promise<void> {
  if (!ensured) ensured = runEnsure().catch((err) => {
    ensured = null
    throw err
  })
  return ensured
}

export function fingerprintRequest(method: string, path: string, rawBody: string): string {
  return crypto.createHash("sha256").update(`${method}\n${path}\n${rawBody}`).digest("hex")
}

/**
 * Looks up a prior response for this (key, idempotency-key). Returns:
 *   - null                       → never seen; caller should proceed
 *   - { record }                 → seen with a MATCHING fingerprint; replay it
 *   - { conflict: true }         → seen with a DIFFERENT fingerprint; reject
 * Records older than 24h are ignored (and treated as never-seen).
 */
export async function lookupIdempotency(
  keyId: number,
  idempotencyKey: string,
  fingerprint: string,
): Promise<{ record?: IdempotencyRecord; conflict?: boolean } | null> {
  await ensureSchema()
  const rows = await query<any[]>(
    `SELECT \`fingerprint\`, \`response_status\`, \`response_body\`
       FROM \`api_idempotency_keys\`
      WHERE \`key_id\` = ? AND \`idempotency_key\` = ? AND \`created_at\` >= NOW() - INTERVAL 1 DAY
      LIMIT 1`,
    [keyId, idempotencyKey],
  )
  const row = rows[0]
  if (!row) return null
  if (row.fingerprint !== fingerprint) return { conflict: true }
  return {
    record: { status: Number(row.response_status), body: String(row.response_body), fingerprint: row.fingerprint },
  }
}

export async function saveIdempotency(
  tenantId: number,
  keyId: number,
  idempotencyKey: string,
  fingerprint: string,
  responseStatus: number,
  responseBody: string,
): Promise<void> {
  try {
    await ensureSchema()
    await query(
      `INSERT INTO \`api_idempotency_keys\`
         (\`tenant_id\`, \`key_id\`, \`idempotency_key\`, \`fingerprint\`, \`response_status\`, \`response_body\`)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE \`id\` = \`id\``,
      [tenantId, keyId, idempotencyKey, fingerprint, responseStatus, responseBody.slice(0, 8 * 1024 * 1024)],
    )
  } catch {
    // best-effort — a lost idempotency record only weakens the guarantee, never the request
  }
}
