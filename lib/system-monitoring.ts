import "server-only"
import { pool } from "@/lib/db"
import { fingerprintOf, redact, redactString, requestReference, safeDbError, SEVERITIES, type MonitorSeverity } from "@/lib/system-monitoring-core"

export { requestReference, safeDbError }
export type MonitorEvent = {
  severity: MonitorSeverity; service: string; component?: string; operation?: string; eventType?: string
  errorCode?: string; message: string; tenantId?: number | null; userId?: number | null
  route?: string; method?: string; httpStatus?: number; requestId?: string; correlationId?: string
  traceId?: string; jobId?: string; webhookId?: string; integration?: string
  durationMs?: number; source?: string; metadata?: unknown; stack?: string
}

const release = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || process.env.npm_package_version || null
const environment = process.env.APP_ENV || process.env.NODE_ENV || "development"
let levelCache: { value: MonitorSeverity; until: number } | null = null
const localRate = new Map<string, { until: number; count: number }>()

async function minSeverity(): Promise<MonitorSeverity> {
  if (levelCache && levelCache.until > Date.now()) return levelCache.value
  let value: MonitorSeverity = "WARNING"
  try {
    const [rows] = await pool.query<any[]>("SELECT min_severity FROM system_monitor_settings WHERE id = 1 LIMIT 1")
    if (SEVERITIES.includes(rows[0]?.min_severity)) value = rows[0].min_severity
  } catch { /* migration may not yet be applied; the logger is never fatal */ }
  levelCache = { value, until: Date.now() + 60_000 }
  return value
}

function allowedByRate(fingerprint: string, severity: MonitorSeverity): boolean {
  if (severity === "ERROR" || severity === "CRITICAL") return true
  if (localRate.size > 1000) localRate.clear()
  const row = localRate.get(fingerprint)
  if (!row || row.until < Date.now()) { localRate.set(fingerprint, { until: Date.now() + 60_000, count: 1 }); return true }
  row.count++
  return row.count <= 5
}

/** Best-effort application telemetry. Never blocks a successful business action. */
export async function persistMonitorEvent(input: MonitorEvent): Promise<void> {
  const severity = SEVERITIES.includes(input.severity) ? input.severity : "ERROR"
  if (SEVERITIES.indexOf(severity) < SEVERITIES.indexOf(await minSeverity())) return
  const service = redactString(input.service).slice(0, 80)
  const component = input.component ? redactString(input.component).slice(0, 80) : null
  const operation = input.operation ? redactString(input.operation).slice(0, 80) : null
  const message = redactString(input.message).slice(0, 1024)
  const errorCode = input.errorCode && /^[A-Z0-9_:-]{1,100}$/.test(input.errorCode) ? input.errorCode : null
  const fingerprint = fingerprintOf({ environment, service, component, operation, errorCode, message })
  if (!allowedByRate(fingerprint, severity)) return
  const metadata = redact(input.metadata ?? null)
  // Do not store a raw exception stack: its first line and arbitrary frames may
  // include SQL values, URLs or credentials. Keep only location references.
  const stack = input.stack ? input.stack.split("\n").slice(1, 12).map((line) => {
    const match = /(?:at\s+[^\s(]+\s+\()?([^\s()]+:\d+:\d+)\)?/.exec(line)
    return match ? redactString(match[1]) : null
  }).filter(Boolean).join("\n").slice(0, 2000) : null
  try {
    let incidentId: number | null = null
    if (severity === "ERROR" || severity === "CRITICAL") {
      const [previous] = await pool.query<any[]>("SELECT id, status FROM system_incidents WHERE environment = ? AND fingerprint = ? LIMIT 1", [environment, fingerprint])
      const [upsert] = await pool.query<any>(
        `INSERT INTO system_incidents (environment, fingerprint, title, service, component, operation, error_code, severity, affected_tenant_count, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), occurrence_count = occurrence_count + 1,
           last_seen_at = UTC_TIMESTAMP(3), severity = VALUES(severity),
           status = IF(status = 'RESOLVED', 'OPEN', status)`,
        [environment, fingerprint, message.slice(0, 255), service, component, operation, errorCode, severity],
      )
      incidentId = Number(upsert.insertId)
      if (!previous[0] || previous[0].status === "RESOLVED") await pool.query(
        "INSERT INTO system_incident_events (incident_id, actor_user_id, action, created_at) VALUES (?, NULL, ?, UTC_TIMESTAMP(3))",
        [incidentId, previous[0] ? "auto_reopen" : "opened"],
      )
      if (input.tenantId && Number.isSafeInteger(input.tenantId)) {
        const [tenant] = await pool.query<any>("INSERT IGNORE INTO system_incident_tenants (incident_id, tenant_id) VALUES (?, ?)", [incidentId, input.tenantId])
        if (tenant.affectedRows) await pool.query("UPDATE system_incidents SET affected_tenant_count = affected_tenant_count + 1 WHERE id = ?", [incidentId])
      }
    }
    const [insert] = await pool.query<any>(
      `INSERT INTO system_logs (created_at, environment, severity, service, component, operation, event_type, error_code, message, tenant_id, user_id, route, method, http_status, request_id, correlation_id, trace_id, job_id, webhook_id, integration, duration_ms, source, release_id, metadata_json, stack_text, fingerprint, incident_id)
       VALUES (UTC_TIMESTAMP(3), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [environment, severity, service, component, operation, input.eventType ? redactString(input.eventType).slice(0, 80) : null, errorCode, message,
        input.tenantId ?? null, input.userId ?? null, input.route ? redactString(input.route.split("?")[0]).slice(0, 255) : null,
        input.method || null, input.httpStatus ?? null, input.requestId ? requestReference(input.requestId) : null,
        input.correlationId ? requestReference(input.correlationId) : null,
        input.traceId ? requestReference(input.traceId) : null, input.jobId ? requestReference(input.jobId) : null,
        input.webhookId ? requestReference(input.webhookId) : null, input.integration ? redactString(input.integration).slice(0, 80) : null,
        input.durationMs ?? null,
        input.source || null, release, metadata == null ? null : (JSON.stringify(metadata).length > 8000 ? JSON.stringify({ truncated: true }) : JSON.stringify(metadata)), stack, fingerprint, incidentId],
    )
    if (incidentId) {
      await pool.query("UPDATE system_incidents SET latest_log_id = ? WHERE id = ?", [insert.insertId, incidentId])
      await evaluateAlertRules(incidentId, severity, service)
    }
  } catch (error) {
    // Deliberately do not call the logger or print the DB driver's raw message.
    console.warn("[system.monitoring] persistence unavailable", JSON.stringify(safeDbError(error)))
  }
}

async function evaluateAlertRules(incidentId: number, severity: MonitorSeverity, service: string) {
  try {
    const [rules] = await pool.query<any[]>(
      `SELECT id, threshold_count, window_minutes, cooldown_minutes FROM system_alert_rules
       WHERE enabled = 1 AND channel = 'in_app' AND severity = ? AND (service IS NULL OR service = ?)`, [severity, service],
    )
    for (const rule of rules) {
      const [counts] = await pool.query<any[]>(
        "SELECT COUNT(*) AS n FROM system_logs WHERE incident_id = ? AND created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? MINUTE)",
        [incidentId, rule.window_minutes],
      )
      if (Number(counts[0]?.n) < Number(rule.threshold_count)) continue
      const bucket = Math.floor(Date.now() / (Number(rule.cooldown_minutes) * 60_000))
      const [insert] = await pool.query<any>(
        "INSERT IGNORE INTO system_alert_deliveries (rule_id, incident_id, channel, status, cooldown_bucket, created_at) VALUES (?, ?, 'in_app', 'delivered', ?, UTC_TIMESTAMP(3))",
        [rule.id, incidentId, bucket],
      )
      if (insert.affectedRows) await pool.query("UPDATE system_alert_rules SET last_fired_at = UTC_TIMESTAMP(3) WHERE id = ?", [rule.id])
    }
  } catch { /* alert delivery is best-effort and cannot affect logging */ }
}

export const monitorLogger = {
  debug: (event: Omit<MonitorEvent, "severity">) => void persistMonitorEvent({ ...event, severity: "DEBUG" }),
  info: (event: Omit<MonitorEvent, "severity">) => void persistMonitorEvent({ ...event, severity: "INFO" }),
  warning: (event: Omit<MonitorEvent, "severity">) => void persistMonitorEvent({ ...event, severity: "WARNING" }),
  error: (event: Omit<MonitorEvent, "severity">) => void persistMonitorEvent({ ...event, severity: "ERROR" }),
  critical: (event: Omit<MonitorEvent, "severity">) => void persistMonitorEvent({ ...event, severity: "CRITICAL" }),
}
