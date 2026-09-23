import "server-only"
import { pool } from "@/lib/db"
import { getIntegrations, getSystemHealth } from "@/lib/platform-metrics"
import { getAppId, getAppSecret } from "@/lib/whatsapp"
import { redactString, SEVERITIES } from "@/lib/system-monitoring-core"

export function pageSize(raw: string | null): number { return Math.max(1, Math.min(100, Number(raw) || 25)) }
export function positiveId(raw: string | null): number | null { const n = Number(raw); return Number.isSafeInteger(n) && n > 0 ? n : null }
export function rangeHours(raw: string | null): number { const n = Number(raw); return [1, 6, 24, 168, 720].includes(n) ? n : 24 }
const textFilter = (raw: string | null, max = 100) => raw && raw.length <= max ? raw : null

export async function listLogs(params: URLSearchParams) {
  const conditions = ["created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR)"]
  const values: unknown[] = [rangeHours(params.get("hours"))]
  const filters: [string, string][] = [["severity", "severity"], ["service", "service"], ["component", "component"], ["operation", "operation"], ["errorCode", "error_code"], ["requestId", "request_id"], ["correlationId", "correlation_id"], ["environment", "environment"], ["route", "route"]]
  for (const [param, column] of filters) { const value = textFilter(params.get(param)); if (value) { conditions.push(`\`${column}\` = ?`); values.push(value) } }
  if (params.has("tenantId")) { const id = positiveId(params.get("tenantId")); if (!id) throw new Error("Invalid tenant ID"); conditions.push("tenant_id = ?"); values.push(id) }
  if (params.has("userId")) { const id = positiveId(params.get("userId")); if (!id) throw new Error("Invalid user ID"); conditions.push("user_id = ?"); values.push(id) }
  if (params.has("httpStatus")) { const status = Number(params.get("httpStatus")); if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error("Invalid HTTP status"); conditions.push("http_status = ?"); values.push(status) }
  const search = textFilter(params.get("search"), 120)
  if (search) { conditions.push("(message LIKE ? OR error_code = ? OR request_id = ? OR correlation_id = ?)"); values.push(`%${search.replace(/[\\%_]/g, "\\$&")}%`, search, search, search) }
  const cursor = positiveId(params.get("cursor")); if (cursor) { conditions.push("id < ?"); values.push(cursor) }
  const limit = pageSize(params.get("limit"))
  const [rows] = await pool.query<any[]>(`SELECT id, created_at, environment, severity, service, component, operation, error_code, message, tenant_id, user_id, route, method, http_status, request_id, correlation_id, duration_ms, incident_id FROM system_logs WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`, [...values, limit + 1])
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null }
}

export async function getLog(id: number) {
  const [rows] = await pool.query<any[]>("SELECT * FROM system_logs WHERE id = ? LIMIT 1", [id])
  return rows[0] || null
}

export async function listIncidents(params: URLSearchParams) {
  const conditions = ["environment = ?"]
  const values: unknown[] = [process.env.APP_ENV || process.env.NODE_ENV || "development"]
  const status = textFilter(params.get("status"), 20)
  if (status && ["OPEN", "ACKNOWLEDGED", "INVESTIGATING", "RESOLVED", "IGNORED"].includes(status)) { conditions.push("status = ?"); values.push(status) }
  const cursor = positiveId(params.get("cursor")); if (cursor) { conditions.push("id < ?"); values.push(cursor) }
  const limit = pageSize(params.get("limit"))
  const [rows] = await pool.query<any[]>(`SELECT * FROM system_incidents WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`, [...values, limit + 1])
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null }
}

export async function getIncident(id: number) {
  const [rows] = await pool.query<any[]>("SELECT * FROM system_incidents WHERE id = ? LIMIT 1", [id])
  if (!rows[0]) return null
  const [events] = await pool.query<any[]>("SELECT id, actor_user_id, action, note, created_at FROM system_incident_events WHERE incident_id = ? ORDER BY id DESC LIMIT 100", [id])
  const [logs] = await pool.query<any[]>("SELECT id, created_at, severity, message, request_id, correlation_id, release_id FROM system_logs WHERE incident_id = ? ORDER BY id DESC LIMIT 50", [id])
  return { ...rows[0], events, logs }
}

export async function updateIncident(id: number, actorId: number, action: string, note?: string, value?: unknown) {
  const status = ({ acknowledge: "ACKNOWLEDGED", investigate: "INVESTIGATING", resolve: "RESOLVED", ignore: "IGNORED", reopen: "OPEN" } as Record<string, string>)[action]
  if (!status && !["note", "assign", "priority"].includes(action)) throw new Error("Invalid incident action")
  if (note && note.length > 1000) throw new Error("Note is too long")
  if (action === "assign" && !positiveId(String(value ?? ""))) throw new Error("Invalid assignee")
  if (action === "priority" && !["P1", "P2", "P3", "P4"].includes(String(value))) throw new Error("Invalid priority")
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [result] = await conn.query<any>("UPDATE system_incidents SET status = COALESCE(?, status) WHERE id = ?", [status || null, id])
    if (!result.affectedRows) { await conn.rollback(); return false }
    if (action === "assign") {
      const [users] = await conn.query<any[]>("SELECT id FROM users WHERE id = ? AND platform_role IN ('platform_staff', 'platform_super_admin') LIMIT 1", [Number(value)])
      if (!users.length) throw new Error("Invalid assignee")
      await conn.query("UPDATE system_incidents SET assigned_to = ? WHERE id = ?", [Number(value), id])
    }
    if (action === "priority") await conn.query("UPDATE system_incidents SET priority = ? WHERE id = ?", [String(value), id])
    const eventNote = note || (["assign", "priority"].includes(action) ? String(value) : null)
    await conn.query("INSERT INTO system_incident_events (incident_id, actor_user_id, action, note, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))", [id, actorId, action, eventNote ? redactString(eventNote).slice(0, 1000) : null])
    await conn.commit()
    return true
  } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
}

export async function dashboard(hours: number) {
  const env = process.env.APP_ENV || process.env.NODE_ENV || "development"
  const system = await getSystemHealth()
  const [totals] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total, SUM(severity = 'ERROR') AS errors, SUM(severity = 'WARNING') AS warnings,
      SUM(severity = 'CRITICAL') AS critical, SUM(service = 'database') AS databaseErrors,
      SUM(service = 'whatsapp') AS whatsappErrors, SUM(service = 'webhook') AS webhookFailures,
      SUM(route IS NOT NULL AND http_status >= 500) AS failedApiRequests
     FROM system_logs WHERE environment = ? AND created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR)`, [env, hours],
  )
  const [incidentRows] = await pool.query<any[]>("SELECT COUNT(*) AS openIncidents, SUM(severity = 'CRITICAL') AS criticalIncidents FROM system_incidents WHERE environment = ? AND status IN ('OPEN','ACKNOWLEDGED','INVESTIGATING')", [env])
  const [trend] = await pool.query<any[]>(`SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:00') AS bucket, severity, COUNT(*) AS count FROM system_logs WHERE environment = ? AND created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR) GROUP BY bucket, severity ORDER BY bucket DESC LIMIT 200`, [env, hours])
  const [services] = await pool.query<any[]>(`SELECT service, COUNT(*) AS count FROM system_logs WHERE environment = ? AND created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR) GROUP BY service ORDER BY count DESC LIMIT 20`, [env, hours])
  const [failedJobs] = await pool.query<any[]>("SELECT COUNT(*) AS n FROM platform_cron_runs WHERE status = 'failed' AND started_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR)", [hours]).catch(() => [[{ n: 0 }]] as any)
  return { environment: env, hours, systemStatus: system.overall, totals: { ...totals[0], ...incidentRows[0], failedJobs: failedJobs[0]?.n || 0 }, trend, services }
}

export async function health() {
  const existing = await getSystemHealth()
  const integrations = getIntegrations()
  const emailConfigured = Boolean(integrations.find((item) => item.name === "Email (SMTP)")?.connected)
  const blobConfigured = Boolean(integrations.find((item) => item.name === "Blob storage")?.connected)
  const config = [
    ["WhatsApp", Boolean(getAppId() && getAppSecret())],
    ["Email/SMTP", emailConfigured],
    ["FCM", Boolean(process.env.FCM_PROJECT_ID)],
    ["Blob storage", blobConfigured],
    ["Cron", Boolean(process.env.CRON_SECRET)],
  ] as const
  const checks = [
    { name: "Application", status: "HEALTHY", reason: `Process responding; uptime ${existing.runtime.uptimeSeconds}s`, responseTimeMs: null as number | null },
    ...existing.checks.map((c) => ({ name: c.name, status: c.status === "ok" ? "HEALTHY" : c.status === "warn" ? "DEGRADED" : "DOWN", reason: c.status === "down" ? "Check failed; see sanitized database diagnostics" : c.detail, responseTimeMs: c.name === "Database" ? Number(/(\d+)ms round-trip/.exec(c.detail)?.[1]) || null : null })),
    ...config.map(([name, configured]) => ({ name, status: configured ? "HEALTHY" : "UNKNOWN", reason: configured ? "Configured" : "Not configured in this runtime", responseTimeMs: null as number | null })),
  ]
  await Promise.allSettled(checks.map((check) => pool.query("INSERT INTO system_health_checks (name, status, safe_reason, response_time_ms, last_checked_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE status = VALUES(status), safe_reason = VALUES(safe_reason), response_time_ms = VALUES(response_time_ms), last_checked_at = UTC_TIMESTAMP(3)", [check.name, check.status, redactString(check.reason), check.responseTimeMs])))
  return { overall: existing.overall, checks, runtime: existing.runtime }
}

export async function settings() {
  const [rows] = await pool.query<any[]>("SELECT * FROM system_monitor_settings WHERE id = 1")
  return rows[0] || null
}

export async function updateSettings(input: Record<string, unknown>) {
  const allowed = ["min_severity", "debug_retention_days", "info_retention_days", "warning_retention_days", "error_retention_days", "critical_retention_days", "slow_request_ms"]
  const changes = Object.entries(input).filter(([key]) => allowed.includes(key))
  if (!changes.length) throw new Error("No valid settings")
  for (const [key, value] of changes) {
    if (key === "min_severity" ? !SEVERITIES.includes(value as any) : !Number.isInteger(value) || Number(value) < 1 || Number(value) > (key === "slow_request_ms" ? 60000 : 3650)) throw new Error(`Invalid ${key}`)
  }
  await pool.query(`UPDATE system_monitor_settings SET ${changes.map(([key]) => `\`${key}\` = ?`).join(", ")}, updated_at = UTC_TIMESTAMP(3) WHERE id = 1`, changes.map(([, value]) => value))
}

export async function listAlerts() {
  const [rules] = await pool.query<any[]>("SELECT * FROM system_alert_rules ORDER BY id DESC LIMIT 100")
  const [deliveries] = await pool.query<any[]>("SELECT * FROM system_alert_deliveries ORDER BY id DESC LIMIT 50")
  return { rules, deliveries }
}

export async function addAlert(input: Record<string, unknown>) {
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : ""
  const severity = String(input.severity || "ERROR")
  const count = Number(input.thresholdCount || 1), window = Number(input.windowMinutes || 5), cooldown = Number(input.cooldownMinutes || 60)
  if (!name || !["ERROR", "CRITICAL"].includes(severity) || ![count, window, cooldown].every((x) => Number.isInteger(x) && x >= 1 && x <= 10080)) throw new Error("Invalid alert rule")
  await pool.query("INSERT INTO system_alert_rules (name, severity, service, threshold_count, window_minutes, cooldown_minutes, created_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))", [name, severity, typeof input.service === "string" && input.service.length <= 80 ? input.service : null, count, window, cooldown])
}

export async function setAlertEnabled(id: number, enabled: boolean) {
  const [result] = await pool.query<any>("UPDATE system_alert_rules SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id])
  return Boolean(result.affectedRows)
}

export async function cleanupBatch(limit = 1000): Promise<number> {
  const s = await settings()
  if (!s) return 0
  let removed = 0
  for (const [severity, column] of [["DEBUG", "debug_retention_days"], ["INFO", "info_retention_days"], ["NOTICE", "info_retention_days"], ["WARNING", "warning_retention_days"], ["ERROR", "error_retention_days"], ["CRITICAL", "critical_retention_days"]]) {
    const [result] = await pool.query<any>("DELETE FROM system_logs WHERE severity = ? AND created_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY) LIMIT ?", [severity, Number(s[column]), Math.max(1, Math.min(1000, limit - removed))])
    removed += Number(result.affectedRows || 0)
    if (removed >= limit) break
  }
  return removed
}

export async function auditMonitor(actorId: number, action: string, targetType: string, targetId?: string) {
  await pool.query("INSERT INTO system_monitor_audit (actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))", [actorId, action, targetType, targetId || null])
}
