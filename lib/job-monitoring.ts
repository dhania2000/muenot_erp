import "server-only"
import { query } from "@/lib/db"
import { ensureBackgroundJobSchema } from "@/lib/background-jobs"
import { ensureCronJobSchema } from "@/lib/cron-jobs"

export type JobScope = { kind: "platform" } | { kind: "tenant"; tenantId: number }
export const MONITOR_STATUSES = ["queued", "running", "completed", "failed", "cancelled", "skipped"] as const
export type MonitorStatus = typeof MONITOR_STATUSES[number]
export type ObservedJob = {
  id: string; kind: "background" | "scheduled"; name: string; tenantId: number | null
  status: MonitorStatus; attempts: number; retries: number; durationMs: number | null
  triggerSource: string; error: string | null; createdAt: string
  deadLetter: boolean; overdue: boolean
}
type Row = {
  id: number; kind: "background" | "scheduled"; name: string; tenant_id: number | null
  status: string; attempts: number; duration_ms: number | null; trigger_source: string
  error_message: string | null; created_at: string; overdue: number
}

// Do not expose arbitrary provider errors: these can contain message bodies,
// reset links, credentials or personal data. Keep a useful safe classification.
export function safeJobError(error: string | null): string | null {
  if (!error) return null
  if (/timed?\s*out|timeout|ETIMEDOUT/i.test(error)) return "Execution timed out."
  if (/ECONNREFUSED|ENOTFOUND|connection/i.test(error)) return "Service connection failed."
  const http = error.match(/HTTP\s+(\d{3})\b/i)
  if (http) return `Service returned HTTP ${http[1]}.`
  return "Execution failed. Contact your administrator with the job ID."
}

export function observeJob(row: Row): ObservedJob {
  const attempts = Number(row.attempts)
  return {
    id: `${row.kind}:${row.id}`, kind: row.kind, name: row.name,
    tenantId: row.tenant_id == null || Number(row.tenant_id) === 0 ? null : Number(row.tenant_id),
    status: row.status === "succeeded" ? "completed" : row.status === "dead_letter" ? "failed" : row.status as MonitorStatus,
    attempts, retries: Math.max(0, attempts - 1),
    durationMs: row.duration_ms == null ? null : Math.max(0, Number(row.duration_ms)),
    triggerSource: row.trigger_source || "unknown", error: safeJobError(row.error_message),
    createdAt: row.created_at, deadLetter: row.status === "dead_letter", overdue: Boolean(Number(row.overdue)),
  }
}

export async function readJobMonitor(scope: JobScope, page = 1) {
  if (scope.kind === "tenant" && (!Number.isSafeInteger(scope.tenantId) || scope.tenantId <= 0)) throw new Error("Invalid tenant scope")
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new Error("Invalid page")
  await ensureBackgroundJobSchema()
  const tenantPredicate = scope.kind === "tenant" ? " WHERE tenant_id=?" : ""
  const params = scope.kind === "tenant" ? [scope.tenantId] : []
  let source = `SELECT id, 'background' AS kind, job_type AS name, tenant_id, status,
    attempts, trigger_source, error_message, created_at, COALESCE(completed_at, updated_at) AS alert_at,
    CASE WHEN started_at IS NULL THEN NULL ELSE TIMESTAMPDIFF(MICROSECOND, started_at, COALESCE(completed_at,NOW())) DIV 1000 END AS duration_ms,
    CASE WHEN status='running' AND locked_at < DATE_SUB(NOW(), INTERVAL timeout_seconds SECOND) THEN 1
      WHEN status='queued' AND available_at < DATE_SUB(NOW(), INTERVAL 15 MINUTE) THEN 1 ELSE 0 END AS overdue
    FROM platform_background_jobs${tenantPredicate}`
  // Global cron sweeps have no tenant ownership; never include them for tenants.
  if (scope.kind === "platform") {
    await ensureCronJobSchema()
    source += ` UNION ALL SELECT id, 'scheduled', job_key, NULL, status, attempt,
      trigger_source, error_message, started_at, COALESCE(finished_at, started_at),
      COALESCE(duration_ms, TIMESTAMPDIFF(MICROSECOND, started_at, COALESCE(finished_at,NOW())) DIV 1000),
      CASE WHEN status='running' AND started_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE) THEN 1 ELSE 0 END
      FROM platform_cron_runs`
  }
  const [rows, counts, alertRows] = await Promise.all([
    query<Row[]>(`SELECT * FROM (${source}) AS jobs ORDER BY created_at DESC, kind, id DESC LIMIT 50 OFFSET ${(page - 1) * 50}`, params),
    query<{status: string; total: number; retried: number}[]>(`SELECT status, COUNT(*) AS total, SUM(attempts>1) AS retried FROM (${source}) AS jobs GROUP BY status`, params),
    query<Row[]>(`SELECT * FROM (${source}) AS jobs
      WHERE overdue=1 OR (status IN ('failed','dead_letter') AND alert_at>=DATE_SUB(NOW(), INTERVAL 24 HOUR))
      ORDER BY created_at DESC, kind, id DESC LIMIT 20`, params),
  ])
  const summary: Record<string, number> = Object.fromEntries(MONITOR_STATUSES.map(s => [s, 0]))
  summary.retried = 0
  let total = 0
  for (const row of counts) {
    const status = row.status === "succeeded" ? "completed" : row.status === "dead_letter" ? "failed" : row.status
    summary[status] = (summary[status] ?? 0) + Number(row.total)
    summary.retried += Number(row.retried)
    total += Number(row.total)
  }
  return { jobs: rows.map(observeJob), alerts: alertRows.map(observeJob), summary, total, page, pageSize: 50, checkedAt: new Date().toISOString() }
}
