import "server-only"
/**
 * Idempotency for unsafe (mutating) requests.
 * ---------------------------------------------------------------------------
 * Callers send an `Idempotency-Key` header on POST/PUT/PATCH/DELETE. The first
 * request with a given (tenant, key_id, idempotency_key) ATOMICALLY reserves the
 * key (INSERT IGNORE on a unique index) before the handler runs, so two
 * concurrent retries can never both execute. When the handler finishes, the
 * reservation is completed with the response; any later replay returns that
 * stored response verbatim.
 *
 * Body-hash matching: the fingerprint is sha256(method, path, canonical body),
 * where a JSON body is canonicalized (object keys sorted recursively) so a
 * semantically identical retry that merely reorders keys / whitespace still
 * replays, while ANY value change is an `idempotency_conflict`.
 *
 * Every statement carries a `tenant_id` predicate (the table is registered in
 * lib/tenant-tables.ts). Records expire after 24h; a pending reservation whose
 * worker died is reclaimable after PENDING_STALE_SECONDS.
 */
import crypto from "crypto"
import { query } from "@/lib/db"

export type IdempotencyRecord = {
  status: number
  body: string
  fingerprint: string
  requestId: string | null
}

export type ReserveOutcome =
  | { kind: "reserved" }
  | { kind: "replay"; record: IdempotencyRecord }
  | { kind: "conflict" }
  | { kind: "in_progress" }

export const IDEMPOTENCY_TTL_HOURS = 24
export const PENDING_STALE_SECONDS = 300
const KEY_RE = /^[\x21-\x7e]{1,128}$/

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`api_idempotency_keys\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED NOT NULL,
      \`key_id\` INT UNSIGNED NOT NULL,
      \`idempotency_key\` VARCHAR(128) NOT NULL,
      \`fingerprint\` VARCHAR(64) NOT NULL,
      \`state\` VARCHAR(16) NOT NULL DEFAULT 'completed',
      \`request_id\` VARCHAR(48) DEFAULT NULL,
      \`response_status\` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      \`response_body\` MEDIUMTEXT NOT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_idem_key\` (\`key_id\`, \`idempotency_key\`),
      KEY \`idx_idem_tenant\` (\`tenant_id\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  // Self-heal tables created before atomic reservation existed.
  const cols = await query<any[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_idempotency_keys'`,
  )
  const have = new Set(cols.map((c) => String(c.COLUMN_NAME)))
  if (!have.has("state")) {
    await query("ALTER TABLE `api_idempotency_keys` ADD COLUMN `state` VARCHAR(16) NOT NULL DEFAULT 'completed' AFTER `fingerprint`")
  }
  if (!have.has("request_id")) {
    await query("ALTER TABLE `api_idempotency_keys` ADD COLUMN `request_id` VARCHAR(48) DEFAULT NULL AFTER `state`")
  }
  if (!have.has("updated_at")) {
    await query(
      "ALTER TABLE `api_idempotency_keys` ADD COLUMN `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
    )
  }
}

function ensureSchema(): Promise<void> {
  if (!ensured)
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  return ensured
}

/** Header values must be 1-128 printable ASCII chars (no spaces). */
export function isValidIdempotencyKey(value: string): boolean {
  return KEY_RE.test(value)
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

/** Canonical body text: sorted-key JSON when parseable, otherwise the raw text. */
export function canonicalBody(rawBody: string): string {
  if (!rawBody) return ""
  try {
    return JSON.stringify(canonicalize(JSON.parse(rawBody)))
  } catch {
    return rawBody
  }
}

export function fingerprintRequest(method: string, path: string, rawBody: string): string {
  return crypto
    .createHash("sha256")
    .update(`${method.toUpperCase()}\n${path}\n${canonicalBody(rawBody)}`)
    .digest("hex")
}

/**
 * Atomically claims (tenant, key, idempotency-key) for this request, or reports
 * what the caller must do instead (replay / conflict / in-progress).
 */
export async function reserveIdempotency(
  tenantId: number,
  keyId: number,
  idempotencyKey: string,
  fingerprint: string,
  requestId: string,
): Promise<ReserveOutcome> {
  await ensureSchema()
  const scope = [tenantId, keyId, idempotencyKey]

  // Expired records never block a fresh request.
  await query(
    `DELETE FROM \`api_idempotency_keys\`
      WHERE \`tenant_id\` = ? AND \`key_id\` = ? AND \`idempotency_key\` = ?
        AND \`created_at\` < NOW() - INTERVAL ${IDEMPOTENCY_TTL_HOURS} HOUR`,
    scope,
  )

  const inserted = await query<any>(
    `INSERT IGNORE INTO \`api_idempotency_keys\`
       (\`tenant_id\`, \`key_id\`, \`idempotency_key\`, \`fingerprint\`, \`state\`, \`request_id\`, \`response_status\`, \`response_body\`)
     VALUES (?, ?, ?, ?, 'pending', ?, 0, '')`,
    [...scope, fingerprint, requestId],
  )
  if (Number(inserted?.affectedRows ?? 0) === 1) return { kind: "reserved" }

  const rows = await query<any[]>(
    `SELECT \`fingerprint\`, \`state\`, \`request_id\`, \`response_status\`, \`response_body\`
       FROM \`api_idempotency_keys\`
      WHERE \`tenant_id\` = ? AND \`key_id\` = ? AND \`idempotency_key\` = ?
      LIMIT 1`,
    scope,
  )
  const row = rows[0]
  // Either another tenant's key id collided (impossible: key ids are global) or
  // a concurrent writer is mid-flight. Fail safe: do not execute.
  if (!row) return { kind: "in_progress" }
  if (String(row.fingerprint) !== fingerprint) return { kind: "conflict" }

  if (String(row.state) === "pending") {
    // Reclaim a reservation abandoned by a crashed worker.
    const taken = await query<any>(
      `UPDATE \`api_idempotency_keys\`
          SET \`request_id\` = ?, \`updated_at\` = NOW()
        WHERE \`tenant_id\` = ? AND \`key_id\` = ? AND \`idempotency_key\` = ?
          AND \`state\` = 'pending' AND \`updated_at\` < NOW() - INTERVAL ${PENDING_STALE_SECONDS} SECOND`,
      [requestId, ...scope],
    )
    return Number(taken?.affectedRows ?? 0) === 1 ? { kind: "reserved" } : { kind: "in_progress" }
  }

  return {
    kind: "replay",
    record: {
      status: Number(row.response_status),
      body: String(row.response_body),
      fingerprint: String(row.fingerprint),
      requestId: row.request_id ? String(row.request_id) : null,
    },
  }
}

/** Stores the final response for a reservation owned by `requestId`. */
export async function completeIdempotency(
  tenantId: number,
  keyId: number,
  idempotencyKey: string,
  requestId: string,
  responseStatus: number,
  responseBody: string,
): Promise<void> {
  await query(
    `UPDATE \`api_idempotency_keys\`
        SET \`state\` = 'completed', \`response_status\` = ?, \`response_body\` = ?
      WHERE \`tenant_id\` = ? AND \`key_id\` = ? AND \`idempotency_key\` = ? AND \`request_id\` = ?`,
    [responseStatus, responseBody.slice(0, 8 * 1024 * 1024), tenantId, keyId, idempotencyKey, requestId],
  )
}

/** Drops a pending reservation (server error / crash) so the client can retry. */
export async function releaseIdempotency(
  tenantId: number,
  keyId: number,
  idempotencyKey: string,
  requestId: string,
): Promise<void> {
  await query(
    `DELETE FROM \`api_idempotency_keys\`
      WHERE \`tenant_id\` = ? AND \`key_id\` = ? AND \`idempotency_key\` = ?
        AND \`request_id\` = ? AND \`state\` = 'pending'`,
    [tenantId, keyId, idempotencyKey, requestId],
  )
}
