import "server-only"
import { createHash, randomUUID } from "node:crypto"
import type { PoolConnection } from "mysql2/promise"
import { query } from "@/lib/db"

export function fingerprint(value: unknown): string {
  function canonical(item: any): any {
    if (Array.isArray(item)) return item.map(canonical)
    if (item && typeof item === "object") return Object.fromEntries(Object.keys(item).sort().filter(k => item[k] !== undefined).map(k => [k, canonical(item[k])]))
    return item
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")
}
let ensured: Promise<void> | undefined
export function ensureIdempotencySchema() {
  return ensured ??= query(`CREATE TABLE IF NOT EXISTS platform_job_receipts (
    operation_key CHAR(64) PRIMARY KEY, request_hash CHAR(64) NOT NULL,
    execution_id CHAR(36) NOT NULL, result JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_job_execution (execution_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).then(() => {}).catch(error => { ensured = undefined; throw error })
}

/** Caller owns the transaction. Receipt and all business writes MUST commit together.
 * Never run external effects or DDL inside this boundary.
 */
export async function claimOperation<T>(connection: PoolConnection, key: string, input: unknown):
  Promise<{ key: string; executionId: string; replay: false } | { key: string; executionId: string; replay: true; result: T }> {
  const operationKey = fingerprint(key)
  const requestHash = fingerprint(input)
  await connection.query(
    "INSERT INTO platform_job_receipts (operation_key, request_hash, execution_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE operation_key=VALUES(operation_key)",
    [operationKey, requestHash, randomUUID()],
  )
  const [rows] = await connection.query<any[]>("SELECT * FROM platform_job_receipts WHERE operation_key=? FOR UPDATE", [operationKey])
  const row = rows[0]
  if (row.request_hash !== requestHash) throw new Error("Idempotency key reused with different operation data")
  if (row.result != null) return { key: operationKey, executionId: row.execution_id, replay: true, result: typeof row.result === "string" ? JSON.parse(row.result) : row.result }
  return { key: operationKey, executionId: row.execution_id, replay: false }
}
export async function finishOperation(connection: PoolConnection, key: string, result: unknown) {
  await connection.query("UPDATE platform_job_receipts SET result=? WHERE operation_key=?", [JSON.stringify(result), key])
}
