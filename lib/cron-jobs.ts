import "server-only"

/**
 * SPEC 40 — Safe scheduled-job configuration.
 *
 * Job definitions are a reviewed allow-list. The database stores only the
 * schedule and operational policy; it never stores shell commands or arbitrary
 * URLs. The dispatcher can therefore invoke only endpoints declared here.
 */
import { query, withTransaction } from "@/lib/db"

export type CronJobDefinition = {
  key: string
  name: string
  description: string
  endpoint: string
  defaultExpression: string
  defaultTimezone: string
  defaultEnabled?: boolean
}

export type CronJobConfig = CronJobDefinition & {
  cron_expression: string
  timezone: string
  start_at: string | null
  end_at: string | null
  enabled: boolean
  retry_limit: number
  timeout_seconds: number
  concurrency_limit: number
  notify_on_failure: boolean
  notification_emails: string | null
  updated_by: number | null
  updated_at: string
}

export type CronRun = {
  id: number
  job_key: string
  scheduled_for: string
  status: "running" | "succeeded" | "failed" | "skipped"
  attempt: number
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  error_message: string | null
  trigger_source: "scheduler" | "manual"
}

// This list mirrors the existing Vercel cron routes. Adding a new job requires
// a code review here; administrators can only edit its safe policy fields.
export const CRON_JOB_DEFINITIONS: readonly CronJobDefinition[] = [
  ["contracts", "Contract reminders", "/api/cron/contracts", "0 6 * * *"],
  ["esign_scheduler", "E-signature scheduler", "/api/cron/esign-scheduler", "0 7 * * *"],
  ["sales_emails", "Sales email queue", "/api/cron/sales-emails", "*/15 * * * *"],
  ["finance_emails", "Finance email queue", "/api/cron/finance-emails", "*/15 * * * *"],
  ["payment_reminders", "Payment reminders", "/api/cron/payment-reminders", "0 7 * * *"],
  ["gst_daily", "Daily GST automation", "/api/cron/gst-daily", "0 8 * * *"],
  ["gst_monthly", "Monthly GST automation", "/api/cron/gst-monthly", "0 9 1 * *"],
  ["tds_daily", "Daily TDS automation", "/api/cron/tds-daily", "0 8 * * *"],
  ["tds_monthly", "Monthly TDS automation", "/api/cron/tds-monthly", "0 9 1 * *"],
  ["tds_quarterly", "Quarterly TDS automation", "/api/cron/tds-quarterly", "0 9 1 */3 *"],
  ["provisions_periodic", "Provisions posting", "/api/cron/provisions-periodic", "0 8 * * *"],
  ["fixed_assets_depreciation", "Fixed-asset depreciation", "/api/cron/fixed-assets-depreciation", "0 9 1 * *"],
  ["loan_reminders", "Loan reminders", "/api/cron/loan-reminders", "0 7 * * *"],
  ["investment_reminders", "Investment reminders", "/api/cron/investment-reminders", "0 7 * * *"],
  ["related_party_scan", "Related-party scan", "/api/cron/related-party-scan", "0 8 * * *"],
  ["recruit_reminders", "Recruitment reminders", "/api/cron/recruit-reminders", "0 7 * * *"],
  ["operations_monitoring", "Operations monitoring", "/api/cron/operations-monitoring", "0 7 * * *"],
  ["calendar_sync", "Calendar sync", "/api/cron/calendar-sync", "*/30 * * * *"],
  ["whatsapp_scheduler", "WhatsApp scheduler", "/api/marketing/whatsapp/scheduler", "*/5 * * * *"],
  ["marketing_journeys", "Marketing journeys", "/api/cron/marketing-journeys", "*/5 * * * *"],
  ["marketing_planner", "Marketing planner", "/api/cron/marketing-planner", "*/5 * * * *"],
  ["notice_board", "Notice board publisher", "/api/cron/notice-board", "*/15 * * * *"],
  ["knowledge_base", "Knowledge-base publisher", "/api/cron/knowledge-base", "*/15 * * * *"],
  ["call_cleanup", "Call cleanup", "/api/cron/call-cleanup", "*/5 * * * *"],
  ["employee_asset_reminders", "Asset reminders", "/api/cron/employee-asset-reminders", "0 7 * * *"],
  ["subscription_reminders", "Subscription reminders", "/api/cron/subscription-reminders", "0 7 * * *"],
  ["subscription_lifecycle", "Subscription lifecycle", "/api/cron/subscription-lifecycle", "0 2 * * *"],
  ["marketing_library", "Marketing library", "/api/cron/marketing-library", "0 7 * * *"],
  ["storage_retention", "Storage retention", "/api/cron/storage-retention", "0 3 * * *"],
  ["background_queue", "Background queue worker", "/api/cron/background-queue", "* * * * *"],
  ["api_rate_limit_cleanup", "API rate-limit counter cleanup", "/api/cron/api-rate-limit-cleanup", "0 4 * * *"],
  ["workflow_worker", "ERP workflow worker", "/api/cron/workflows", "* * * * *"],
  ["business_events", "Business event deliveries", "/api/cron/business-events", "* * * * *"],
  ["notification_delivery", "Notification delivery worker", "/api/cron/notification-delivery", "* * * * *"],
].map(([key, name, endpoint, expression]) => ({
  key,
  name,
  description: `Allow-listed internal job: ${endpoint}`,
  endpoint,
  defaultExpression: expression,
  defaultTimezone: "UTC",
}))

const definitions = new Map(CRON_JOB_DEFINITIONS.map((job) => [job.key, job]))
export function getCronJobDefinition(key: string): CronJobDefinition | null {
  return definitions.get(key) ?? null
}

function parsePart(part: string, min: number, max: number): number[] | null {
  const [base, stepRaw] = part.split("/")
  const step = stepRaw == null ? 1 : Number(stepRaw)
  if (!Number.isInteger(step) || step < 1) return null
  if (base === "*") return Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => min + i * step)
  const range = base.split("-")
  const start = Number(range[0])
  const end = range.length === 2 ? Number(range[1]) : start
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) return null
  const out: number[] = []
  for (let value = start; value <= end; value += step) out.push(value)
  return out
}

export function validateCronExpression(expression: string): { ok: true } | { ok: false; error: string } {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return { ok: false, error: "Cron expression must contain exactly 5 fields" }
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i] || fields[i].split(",").some((part) => parsePart(part, ranges[i][0], ranges[i][1]) == null)) {
      return { ok: false, error: `Invalid cron field ${i + 1}` }
    }
  }
  return { ok: true }
}

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((part) => parsePart(part, min, max)?.includes(value))
}

/** Match a five-field expression using the configured IANA timezone. */
export function matchesCronExpression(expression: string, at: Date, timezone: string): boolean {
  if (validateCronExpression(expression).ok === false) return false
  let parts: Record<string, number> = {}
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      minute: "numeric",
      hour: "numeric",
      day: "numeric",
      month: "numeric",
      weekday: "short",
      hour12: false,
    }).formatToParts(at)
    const values = Object.fromEntries(formatted.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]))
    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    parts = {
      minute: Number(values.minute), hour: Number(values.hour) % 24, day: Number(values.day),
      month: Number(values.month), weekday: weekdays.indexOf(values.weekday),
    }
  } catch {
    return false
  }
  const [minute, hour, day, month, weekday] = expression.trim().split(/\s+/)
  const dayMatch = fieldMatches(day, parts.day, 1, 31)
  const weekdayMatch = fieldMatches(weekday, parts.weekday, 0, 6)
  const dayRestricted = day !== "*"
  const weekdayRestricted = weekday !== "*"
  const calendarMatch = dayRestricted && weekdayRestricted ? dayMatch || weekdayMatch : dayMatch && weekdayMatch
  return fieldMatches(minute, parts.minute, 0, 59) && fieldMatches(hour, parts.hour, 0, 23) &&
    fieldMatches(month, parts.month, 1, 12) && calendarMatch
}

let ensured: Promise<void> | null = null
async function runEnsure() {
  await query(`CREATE TABLE IF NOT EXISTS platform_cron_jobs (
    job_key VARCHAR(100) NOT NULL PRIMARY KEY,
    cron_expression VARCHAR(120) NOT NULL,
    timezone VARCHAR(80) NOT NULL DEFAULT 'UTC',
    start_at DATETIME NULL,
    end_at DATETIME NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    retry_limit TINYINT UNSIGNED NOT NULL DEFAULT 2,
    timeout_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 300,
    concurrency_limit TINYINT UNSIGNED NOT NULL DEFAULT 1,
    notify_on_failure TINYINT(1) NOT NULL DEFAULT 1,
    notification_emails VARCHAR(1000) NULL,
    updated_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_platform_cron_enabled (enabled), KEY idx_platform_cron_schedule (cron_expression)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS platform_cron_runs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    job_key VARCHAR(100) NOT NULL,
    scheduled_for DATETIME NOT NULL,
    status ENUM('running','succeeded','failed','skipped') NOT NULL DEFAULT 'running',
    attempt TINYINT UNSIGNED NOT NULL DEFAULT 1,
    started_at DATETIME NOT NULL,
    finished_at DATETIME NULL,
    duration_ms INT UNSIGNED NULL,
    error_message TEXT NULL,
    trigger_source ENUM('scheduler','manual') NOT NULL DEFAULT 'scheduler',
    PRIMARY KEY (id), UNIQUE KEY uniq_platform_cron_slot (job_key, scheduled_for),
    KEY idx_platform_cron_runs_status (status, started_at), KEY idx_platform_cron_runs_job (job_key, started_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await query(`CREATE TABLE IF NOT EXISTS platform_cron_audit (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    job_key VARCHAR(100) NOT NULL,
    action VARCHAR(40) NOT NULL,
    detail JSON NULL,
    actor_user_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id), KEY idx_platform_cron_audit_job (job_key, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  for (const job of CRON_JOB_DEFINITIONS) {
    await query(
      `INSERT INTO platform_cron_jobs (job_key, cron_expression, timezone, enabled)
       VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE job_key=VALUES(job_key)`,
      [job.key, job.defaultExpression, job.defaultTimezone, job.defaultEnabled === false ? 0 : 1],
    )
  }
}

export async function ensureCronJobSchema() {
  if (!ensured) ensured = runEnsure().catch((error) => { ensured = null; throw error })
  return ensured
}

function mapConfig(row: any): CronJobConfig {
  const definition = getCronJobDefinition(row.job_key)!
  return { ...definition, ...row, enabled: Boolean(row.enabled), notify_on_failure: Boolean(row.notify_on_failure) }
}

export async function listCronJobs(): Promise<CronJobConfig[]> {
  await ensureCronJobSchema()
  const rows = await query<any[]>("SELECT * FROM platform_cron_jobs ORDER BY job_key")
  return rows.map(mapConfig)
}

export async function updateCronJob(key: string, input: Partial<Pick<CronJobConfig, "cron_expression" | "timezone" | "start_at" | "end_at" | "enabled" | "retry_limit" | "timeout_seconds" | "concurrency_limit" | "notify_on_failure" | "notification_emails">>, actorUserId: number): Promise<CronJobConfig> {
  const definition = getCronJobDefinition(key)
  if (!definition) throw new Error("Unknown scheduled job")
  const expression = String(input.cron_expression ?? definition.defaultExpression).trim()
  const cron = validateCronExpression(expression)
  if (!cron.ok) throw new Error(cron.error)
  const timezone = String(input.timezone ?? definition.defaultTimezone).trim()
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format() } catch { throw new Error("Invalid IANA timezone") }
  const retry = Math.min(10, Math.max(0, Math.floor(Number(input.retry_limit ?? 2))))
  const timeout = Math.min(900, Math.max(5, Math.floor(Number(input.timeout_seconds ?? 300))))
  const concurrency = Math.min(20, Math.max(1, Math.floor(Number(input.concurrency_limit ?? 1))))
  const emails = input.notification_emails == null ? null : String(input.notification_emails).trim().slice(0, 1000)
  if (emails && emails.split(",").some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))) throw new Error("Invalid notification email")
  await ensureCronJobSchema()
  await query(`UPDATE platform_cron_jobs SET cron_expression=?, timezone=?, start_at=?, end_at=?, enabled=?, retry_limit=?, timeout_seconds=?, concurrency_limit=?, notify_on_failure=?, notification_emails=?, updated_by=? WHERE job_key=?`, [
    expression, timezone, input.start_at || null, input.end_at || null, input.enabled === false ? 0 : 1,
    retry, timeout, concurrency, input.notify_on_failure === false ? 0 : 1, emails, actorUserId, key,
  ])
  await query("INSERT INTO platform_cron_audit (job_key, action, detail, actor_user_id) VALUES (?,?,?,?)", [key, "config_update", JSON.stringify({ expression, timezone, enabled: input.enabled !== false }), actorUserId])
  const rows = await query<any[]>("SELECT * FROM platform_cron_jobs WHERE job_key=? LIMIT 1", [key])
  return mapConfig(rows[0])
}

export async function listCronRuns(limit = 100): Promise<CronRun[]> {
  await ensureCronJobSchema()
  const safe = Math.min(200, Math.max(1, Math.floor(Number(limit) || 100)))
  return query<CronRun[]>(`SELECT * FROM platform_cron_runs ORDER BY started_at DESC LIMIT ${safe}`)
}

function slotDate(now: Date): string {
  return now.toISOString().slice(0, 16).replace("T", " ") + ":00"
}

export function isCronConfigDue(job: CronJobConfig, now = new Date()): boolean {
  if (!job.enabled || !matchesCronExpression(job.cron_expression, now, job.timezone)) return false
  const start = job.start_at ? new Date(job.start_at).getTime() : -Infinity
  const end = job.end_at ? new Date(job.end_at).getTime() : Infinity
  return now.getTime() >= start && now.getTime() <= end
}

export async function claimCronRun(job: CronJobConfig, now = new Date()): Promise<{ id: number; scheduledFor: string } | null> {
  await ensureCronJobSchema()
  const scheduledFor = slotDate(now)
  return withTransaction(async connection => {
    // Serialize admission for this job across scheduler instances.
    await connection.query("SELECT job_key FROM platform_cron_jobs WHERE job_key=? FOR UPDATE", [job.key])
    const [running] = await connection.query<any[]>("SELECT id FROM platform_cron_runs WHERE job_key=? AND status='running' FOR UPDATE", [job.key])
    if (running.length >= job.concurrency_limit) return null
    try {
      const [result] = await connection.query<any>("INSERT INTO platform_cron_runs (job_key, scheduled_for, status, attempt, started_at, trigger_source) VALUES (?,?,?,?,?,?)", [job.key, scheduledFor, "running", 1, now, "scheduler"])
      return { id: Number(result.insertId), scheduledFor }
    } catch (error: any) {
      if (error?.code === "ER_DUP_ENTRY") return null
      throw error
    }
  })
}

export async function finishCronRun(id: number, status: CronRun["status"], startedAt: number, errorMessage: string | null) {
  await query("UPDATE platform_cron_runs SET status=?, finished_at=NOW(), duration_ms=?, error_message=? WHERE id=?", [status, Math.max(0, Date.now() - startedAt), errorMessage, id])
}

export async function updateCronRunAttempt(id: number, attempt: number) {
  await query("UPDATE platform_cron_runs SET attempt=? WHERE id=?", [attempt, id])
}
