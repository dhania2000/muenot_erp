import "server-only"
/**
 * SPEC 51 — API request audit logging + rate-usage telemetry source.
 * ---------------------------------------------------------------------------
 * Every authenticated (and every rejected-after-identification) request to the
 * public API is recorded here: who (key), what (method + path), the outcome
 * (status + error code), latency, source IP, and the correlating request id.
 * This is the backing store for the SPEC 53 "API usage" dashboard and the
 * forensic trail for security review. Writes are best-effort — logging must
 * never change or slow the request's own result.
 */
import { query } from "@/lib/db"

export type ApiRequestLogRow = {
  id: number
  tenant_id: number | null
  key_id: number | null
  request_id: string
  method: string
  path: string
  status: number
  error_code: string | null
  api_version: string
  environment: string | null
  ip: string | null
  duration_ms: number | null
  created_at: string
}

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`api_request_audit\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT UNSIGNED DEFAULT NULL,
      \`key_id\` INT UNSIGNED DEFAULT NULL,
      \`request_id\` VARCHAR(48) NOT NULL,
      \`method\` VARCHAR(8) NOT NULL,
      \`path\` VARCHAR(512) NOT NULL,
      \`status\` SMALLINT UNSIGNED NOT NULL,
      \`error_code\` VARCHAR(48) DEFAULT NULL,
      \`api_version\` VARCHAR(24) NOT NULL,
      \`environment\` VARCHAR(8) DEFAULT NULL,
      \`ip\` VARCHAR(64) DEFAULT NULL,
      \`duration_ms\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_api_audit_tenant\` (\`tenant_id\`),
      KEY \`idx_api_audit_key\` (\`key_id\`),
      KEY \`idx_api_audit_created\` (\`created_at\`),
      KEY \`idx_api_audit_request\` (\`request_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

export function ensureApiAuditSchema(): Promise<void> {
  if (!ensured) ensured = runEnsure().catch((err) => {
    ensured = null
    throw err
  })
  return ensured
}

export async function logApiRequest(entry: {
  tenantId: number | null
  keyId: number | null
  requestId: string
  method: string
  path: string
  status: number
  errorCode?: string | null
  apiVersion: string
  environment?: string | null
  ip?: string | null
  durationMs?: number | null
}): Promise<void> {
  try {
    await ensureApiAuditSchema()
    await query(
      `INSERT INTO \`api_request_audit\`
         (\`tenant_id\`, \`key_id\`, \`request_id\`, \`method\`, \`path\`, \`status\`, \`error_code\`, \`api_version\`, \`environment\`, \`ip\`, \`duration_ms\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.tenantId,
        entry.keyId,
        entry.requestId,
        entry.method,
        entry.path.slice(0, 512),
        entry.status,
        entry.errorCode ?? null,
        entry.apiVersion,
        entry.environment ?? null,
        entry.ip ?? null,
        entry.durationMs ?? null,
      ],
    )
  } catch {
    // best-effort
  }
}

export type ApiUsageSummary = {
  totalRequests: number
  errorRequests: number
  rateLimitedRequests: number
  requestsLast24h: number
  requestsLastHour: number
  byStatusClass: { class: string; count: number }[]
  topPaths: { path: string; count: number }[]
}

/** Aggregates the audit table into the numbers the SPEC 53 usage dashboard shows. */
export async function getApiUsageSummary(tenantId: number): Promise<ApiUsageSummary> {
  await ensureApiAuditSchema()
  const [totals] = await query<any[]>(
    `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN \`status\` >= 400 THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN \`status\` = 429 THEN 1 ELSE 0 END) AS rate_limited,
        SUM(CASE WHEN \`created_at\` >= NOW() - INTERVAL 1 DAY THEN 1 ELSE 0 END) AS last_24h,
        SUM(CASE WHEN \`created_at\` >= NOW() - INTERVAL 1 HOUR THEN 1 ELSE 0 END) AS last_hour
      FROM \`api_request_audit\` WHERE \`tenant_id\` = ?`,
    [tenantId],
  )
  const byStatus = await query<any[]>(
    `SELECT CONCAT(FLOOR(\`status\` / 100), 'xx') AS class, COUNT(*) AS count
       FROM \`api_request_audit\` WHERE \`tenant_id\` = ?
       GROUP BY class ORDER BY class`,
    [tenantId],
  )
  const topPaths = await query<any[]>(
    `SELECT \`path\`, COUNT(*) AS count
       FROM \`api_request_audit\` WHERE \`tenant_id\` = ?
       GROUP BY \`path\` ORDER BY count DESC LIMIT 10`,
    [tenantId],
  )
  return {
    totalRequests: Number(totals?.total ?? 0),
    errorRequests: Number(totals?.errors ?? 0),
    rateLimitedRequests: Number(totals?.rate_limited ?? 0),
    requestsLast24h: Number(totals?.last_24h ?? 0),
    requestsLastHour: Number(totals?.last_hour ?? 0),
    byStatusClass: byStatus.map((r) => ({ class: String(r.class), count: Number(r.count) })),
    topPaths: topPaths.map((r) => ({ path: String(r.path), count: Number(r.count) })),
  }
}

export async function listRecentApiRequests(tenantId: number, limit = 50): Promise<ApiRequestLogRow[]> {
  await ensureApiAuditSchema()
  const capped = Math.min(Math.max(limit, 1), 200)
  return query<ApiRequestLogRow[]>(
    `SELECT * FROM \`api_request_audit\` WHERE \`tenant_id\` = ? ORDER BY \`created_at\` DESC LIMIT ?`,
    [tenantId, capped],
  )
}
