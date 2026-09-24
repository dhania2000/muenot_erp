import "server-only"

/**
 * SPEC 98 — Report Scheduler (DB-backed store + delivery + cron runner).
 *
 * Phase 1 (connect reports to scheduler): a schedule references a saved report
 * from the SPEC 97 builder (`lib/reports/store`) and, when due, re-runs that
 * report through the same permission-aware query builder used by the on-demand
 * export route, so a scheduled artifact is identical to a manual one.
 *
 * Phase 2 (report-job model): every fire produces a durable `report_schedule_runs`
 * row (the "report job") capturing status, row/byte counts, the delivery channel
 * and — for storage delivery — the artifact bytes behind an HMAC download link.
 * A `UNIQUE(schedule_id, slot)` guard makes each minute-slot idempotent across
 * parallel dispatcher workers, mirroring `platform_cron_runs`.
 *
 * Delivery channels:
 *   • email   — the exact artifact is attached to a message to each recipient.
 *   • storage — the artifact is retained and fetched via a signed, expiring link.
 *
 * Large reports and failed deliveries are first-class: artifacts over
 * `SCHEDULER_CAPS.maxArtifactBytes` fail the run with a clear message rather
 * than throwing, and any delivery error is captured on the run row so the UI
 * can surface it (see `test/reports-scheduler-model.test.ts` for the pure rules
 * and the delivery-outcome helpers exercised here).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { query, withTransaction } from "@/lib/db"
import { recordAuditLog } from "@/lib/audit-log-store"
import { sendEmail, type OutgoingAttachment } from "@/lib/email"
import { matchesCronExpression } from "@/lib/cron-jobs"
import { getReport, type Actor } from "@/lib/reports/store"
import { runReport, type RunReportResult } from "@/lib/reports/query-builder"
import type { TenantRole } from "@/lib/role-model"
import {
  SCHEDULER_CAPS,
  assertRecipientPermission,
  buildCronExpression,
  describeSchedule,
  isDeliveryChannel,
  isDeliveryFormat,
  isScheduleFrequency,
  parseRecipients,
  reportArtifactFileName,
  slotKey,
  FORMAT_CONTENT_TYPE,
  type CadenceInput,
  type DeliveryChannel,
  type DeliveryFormat,
  type ScheduleFrequency,
  type ScheduleStatus,
} from "@/lib/reports/scheduler-model"

export type { Actor }

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type ReportSchedule = {
  id: number
  tenantId: number | null
  reportId: number
  reportName: string
  frequency: ScheduleFrequency
  cronExpression: string
  timezone: string
  format: DeliveryFormat
  channel: DeliveryChannel
  recipients: string[]
  status: ScheduleStatus
  description: string
  lastRunAt: string | null
  lastStatus: string | null
  createdBy: number | null
  createdByName: string | null
  createdAt: string
}

export type ReportScheduleRun = {
  id: number
  scheduleId: number
  status: "success" | "failed" | "skipped"
  format: DeliveryFormat
  channel: DeliveryChannel
  rowCount: number
  byteSize: number
  recipientsCount: number
  fileName: string | null
  error: string | null
  triggerSource: "scheduler" | "manual"
  downloadUrl: string | null
  startedAt: string
  finishedAt: string | null
}

// ---------------------------------------------------------------------------
// Schema (self-healing, matches the platform conventions)
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null
async function runEnsure() {
  await query(`CREATE TABLE IF NOT EXISTS report_schedules (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id INT NULL,
    report_id BIGINT UNSIGNED NOT NULL,
    report_name VARCHAR(200) NOT NULL,
    frequency ENUM('daily','weekly','monthly','custom') NOT NULL,
    cron_expression VARCHAR(120) NOT NULL,
    timezone VARCHAR(80) NOT NULL DEFAULT 'UTC',
    format ENUM('pdf','xlsx','csv') NOT NULL DEFAULT 'pdf',
    channel ENUM('email','storage') NOT NULL DEFAULT 'email',
    recipients TEXT NULL,
    status ENUM('active','paused') NOT NULL DEFAULT 'active',
    last_run_at DATETIME NULL,
    last_status VARCHAR(20) NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_report_schedules_tenant (tenant_id, status),
    KEY idx_report_schedules_report (report_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS report_schedule_runs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    schedule_id BIGINT UNSIGNED NOT NULL,
    tenant_id INT NULL,
    slot VARCHAR(20) NOT NULL,
    status ENUM('running','success','failed','skipped') NOT NULL DEFAULT 'running',
    format ENUM('pdf','xlsx','csv') NOT NULL,
    channel ENUM('email','storage') NOT NULL,
    row_count INT UNSIGNED NOT NULL DEFAULT 0,
    byte_size INT UNSIGNED NOT NULL DEFAULT 0,
    recipients_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    file_name VARCHAR(255) NULL,
    content_type VARCHAR(150) NULL,
    artifact LONGBLOB NULL,
    token_salt VARCHAR(48) NULL,
    expires_at DATETIME NULL,
    error TEXT NULL,
    trigger_source ENUM('scheduler','manual') NOT NULL DEFAULT 'scheduler',
    started_at DATETIME NOT NULL,
    finished_at DATETIME NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_report_run_slot (schedule_id, slot),
    KEY idx_report_runs_schedule (schedule_id, started_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}
export async function ensureReportSchedulerSchema() {
  if (!ensured) ensured = runEnsure().catch((e) => { ensured = null; throw e })
  return ensured
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type ScheduleRow = {
  id: number
  tenant_id: number | null
  report_id: number
  report_name: string
  frequency: ScheduleFrequency
  cron_expression: string
  timezone: string
  format: DeliveryFormat
  channel: DeliveryChannel
  recipients: string | null
  status: ScheduleStatus
  last_run_at: string | null
  last_status: string | null
  created_by: number | null
  created_by_name?: string | null
  created_at: string
}

function toPublicSchedule(row: ScheduleRow): ReportSchedule {
  return {
    id: Number(row.id),
    tenantId: row.tenant_id,
    reportId: Number(row.report_id),
    reportName: row.report_name,
    frequency: row.frequency,
    cronExpression: row.cron_expression,
    timezone: row.timezone,
    format: row.format,
    channel: row.channel,
    recipients: row.recipients ? (JSON.parse(row.recipients) as string[]) : [],
    status: row.status,
    description: describeSchedule(row.frequency, row.cron_expression),
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at,
  }
}

const SCHEDULE_SELECT = `
  SELECT s.id, s.tenant_id, s.report_id, s.report_name, s.frequency, s.cron_expression, s.timezone,
         s.format, s.channel, s.recipients, s.status, s.last_run_at, s.last_status,
         s.created_by, u.name AS created_by_name, s.created_at
    FROM report_schedules s
    LEFT JOIN users u ON u.id = s.created_by`

// ---------------------------------------------------------------------------
// Download token (HMAC, bound to run + tenant + per-run salt + expiry)
// ---------------------------------------------------------------------------

function signingSecret(): string {
  return process.env.STORAGE_URL_SIGNING_SECRET || process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me"
}
function computeToken(runId: number, tenantId: number | null, salt: string, exp: number): string {
  return createHmac("sha256", signingSecret())
    .update(`${runId}\n${tenantId ?? "null"}\n${salt}\n${exp}`)
    .digest("hex")
}
export function buildRunDownloadPath(run: {
  id: number
  tenantId: number | null
  tokenSalt: string | null
  expiresAt: string | null
}): string | null {
  if (!run.tokenSalt || !run.expiresAt) return null
  const exp = new Date(run.expiresAt).getTime()
  const sig = computeToken(run.id, run.tenantId, run.tokenSalt, exp)
  return `/api/reports/schedules/download/${run.id}?exp=${exp}&sig=${sig}`
}
function verifyToken(
  run: { id: number; tenantId: number | null; tokenSalt: string | null; expiresAt: string | null },
  exp: number,
  sig: string,
): { valid: boolean; reason?: string } {
  if (!run.tokenSalt) return { valid: false, reason: "revoked" }
  if (!Number.isFinite(exp) || Date.now() > exp) return { valid: false, reason: "expired" }
  const expected = computeToken(run.id, run.tenantId, run.tokenSalt, exp)
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: "bad-signature" }
  return { valid: true }
}

// ---------------------------------------------------------------------------
// Artifact serialization (server-side; mirrors the on-demand export formats)
// ---------------------------------------------------------------------------

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function serializeCsv(result: RunReportResult): Buffer {
  const escape = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)
  const lines: string[] = []
  lines.push(result.columns.map((c) => escape(c.label)).join(","))
  for (const row of result.rows) {
    lines.push(result.columns.map((c) => escape(cellText(row[c.key]))).join(","))
  }
  return Buffer.from(lines.join("\r\n"), "utf-8")
}

async function serializeXlsx(reportName: string, result: RunReportResult): Promise<Buffer> {
  const XLSX = await import("xlsx")
  const header = result.columns.map((c) => c.label)
  const body = result.rows.map((row) => result.columns.map((c) => {
    const v = row[c.key]
    return v instanceof Date ? v.toISOString() : (v as any)
  }))
  const ws = XLSX.utils.aoa_to_sheet([header, ...body])
  ws["!cols"] = result.columns.map((c) => ({ wch: Math.max(12, c.label.length + 2) }))
  const wb = XLSX.utils.book_new()
  const sheetName = (reportName || "Report").replace(/[\\/?*[\]:]/g, " ").slice(0, 28) || "Report"
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer
  return Buffer.isBuffer(out) ? out : Buffer.from(out)
}

async function serializePdf(reportName: string, result: RunReportResult): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib")
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const margin = 40
  const pageWidth = 841.89 // A4 landscape — reports are usually wide.
  const pageHeight = 595.28
  const lineHeight = 12
  let page = doc.addPage([pageWidth, pageHeight])
  let y = pageHeight - margin

  const draw = (text: string, opts: { font?: typeof font; size?: number; color?: ReturnType<typeof rgb> } = {}) => {
    const size = opts.size ?? 8
    if (y < margin + lineHeight) {
      page = doc.addPage([pageWidth, pageHeight])
      y = pageHeight - margin
    }
    const clean = text.replace(/[\r\n\t]+/g, " ")
    const maxChars = Math.floor((pageWidth - margin * 2) / (size * 0.5))
    page.drawText(clean.slice(0, maxChars), {
      x: margin,
      y,
      size,
      font: opts.font ?? font,
      color: opts.color ?? rgb(0.1, 0.1, 0.1),
    })
    y -= lineHeight
  }

  draw(reportName || "Report", { font: bold, size: 16 })
  draw(`Generated ${new Date().toISOString()} — ${result.rows.length} record(s)`, { size: 8, color: rgb(0.4, 0.4, 0.4) })
  y -= lineHeight

  const cols = result.columns.slice(0, 10)
  draw(cols.map((c) => c.label).join("  |  "), { font: bold, size: 7, color: rgb(0.3, 0.3, 0.3) })
  const cap = Math.min(result.rows.length, 2000)
  for (let i = 0; i < cap; i++) {
    const row = result.rows[i]
    draw(cols.map((c) => cellText(row[c.key])).join("  |  "), { size: 7 })
  }
  if (result.rows.length > cap) {
    draw(`… ${result.rows.length - cap} more row(s) omitted`, { size: 7, color: rgb(0.4, 0.4, 0.4) })
  }

  const out = await doc.save()
  return Buffer.from(out)
}

async function serializeArtifact(
  format: DeliveryFormat,
  reportName: string,
  result: RunReportResult,
): Promise<{ bytes: Buffer; contentType: string }> {
  const contentType = FORMAT_CONTENT_TYPE[format]
  if (format === "csv") return { bytes: serializeCsv(result), contentType }
  if (format === "xlsx") return { bytes: await serializeXlsx(reportName, result), contentType }
  return { bytes: await serializePdf(reportName, result), contentType }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listReportSchedules(tenantId: number | null): Promise<ReportSchedule[]> {
  await ensureReportSchedulerSchema()
  const rows = await query<ScheduleRow[]>(
    `${SCHEDULE_SELECT} WHERE s.tenant_id <=> ? ORDER BY s.created_at DESC`,
    [tenantId],
  )
  return rows.map(toPublicSchedule)
}

export async function getReportSchedule(tenantId: number | null, id: number): Promise<ReportSchedule | null> {
  await ensureReportSchedulerSchema()
  const rows = await query<ScheduleRow[]>(`${SCHEDULE_SELECT} WHERE s.id = ? AND s.tenant_id <=> ? LIMIT 1`, [id, tenantId])
  return rows[0] ? toPublicSchedule(rows[0]) : null
}

export type CreateReportScheduleInput = {
  reportId: unknown
  frequency: unknown
  format: unknown
  channel: unknown
  recipients?: unknown
  timezone?: unknown
  cadence?: CadenceInput
  customCron?: string | null
}

function normalizeTimezone(tz: unknown): string {
  const value = String(tz ?? "UTC").trim() || "UTC"
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format()
    return value
  } catch {
    throw new Error("Invalid IANA timezone.")
  }
}

export async function createReportSchedule(
  tenantId: number | null,
  input: CreateReportScheduleInput,
  actor: Actor,
): Promise<ReportSchedule> {
  await ensureReportSchedulerSchema()

  const reportId = Math.floor(Number(input.reportId))
  if (!Number.isInteger(reportId) || reportId <= 0) throw new Error("A valid report is required.")

  // Phase 1: connect the schedule to a real saved report in this tenant.
  const report = await getReport(tenantId, reportId)
  if (!report) throw new Error("The selected report does not exist.")

  if (!isScheduleFrequency(input.frequency)) throw new Error("Unsupported frequency.")
  if (!isDeliveryFormat(input.format)) throw new Error("Unsupported delivery format.")
  if (!isDeliveryChannel(input.channel)) throw new Error("Unsupported delivery channel.")

  const cronExpression = buildCronExpression(input.frequency, input.cadence ?? {}, input.customCron)
  const timezone = normalizeTimezone(input.timezone)
  const recipients = assertRecipientPermission(input.channel, input.recipients)

  const res = await query<{ insertId: number }>(
    `INSERT INTO report_schedules
       (tenant_id, report_id, report_name, frequency, cron_expression, timezone, format, channel, recipients, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [
      tenantId,
      reportId,
      report.name.slice(0, 200),
      input.frequency,
      cronExpression,
      timezone,
      input.format,
      input.channel,
      recipients.length ? JSON.stringify(recipients) : null,
      actor.userId,
    ],
  )
  const id = Number((res as any).insertId)

  await recordAuditLog({
    action: "report.schedule_create",
    entityType: "report_schedule",
    entityId: id,
    entityLabel: `${report.name} (${String(input.format).toUpperCase()}, ${input.frequency})`,
    after: { reportId, frequency: input.frequency, cronExpression, format: input.format, channel: input.channel, recipients },
    context: auditContext(tenantId, actor),
  }).catch(() => {})

  const created = await getReportSchedule(tenantId, id)
  if (!created) throw new Error("Failed to create schedule.")
  return created
}

export async function setReportScheduleStatus(
  tenantId: number | null,
  id: number,
  status: ScheduleStatus,
  actor: Actor,
): Promise<ReportSchedule | null> {
  await ensureReportSchedulerSchema()
  const existing = await getReportSchedule(tenantId, id)
  if (!existing) return null
  await query(`UPDATE report_schedules SET status = ? WHERE id = ? AND tenant_id <=> ?`, [status, id, tenantId])
  await recordAuditLog({
    action: "report.schedule_status",
    entityType: "report_schedule",
    entityId: id,
    entityLabel: existing.reportName,
    before: { status: existing.status },
    after: { status },
    context: auditContext(tenantId, actor),
  }).catch(() => {})
  return getReportSchedule(tenantId, id)
}

export async function deleteReportSchedule(tenantId: number | null, id: number, actor: Actor): Promise<boolean> {
  await ensureReportSchedulerSchema()
  const existing = await getReportSchedule(tenantId, id)
  if (!existing) return false
  await query(`DELETE FROM report_schedules WHERE id = ? AND tenant_id <=> ?`, [id, tenantId])
  await query(`DELETE FROM report_schedule_runs WHERE schedule_id = ? AND tenant_id <=> ?`, [id, tenantId])
  await recordAuditLog({
    action: "report.schedule_delete",
    entityType: "report_schedule",
    entityId: id,
    entityLabel: existing.reportName,
    before: { frequency: existing.frequency, format: existing.format, channel: existing.channel },
    context: auditContext(tenantId, actor),
  }).catch(() => {})
  return true
}

function auditContext(tenantId: number | null, actor: Actor) {
  return {
    tenantId,
    actorUserId: actor.userId,
    actorName: actor.name ?? null,
    actorEmail: actor.email ?? null,
    actorRole: actor.role,
  }
}

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

type RunRow = {
  id: number
  schedule_id: number
  tenant_id: number | null
  status: "running" | "success" | "failed" | "skipped"
  format: DeliveryFormat
  channel: DeliveryChannel
  row_count: number
  byte_size: number
  recipients_count: number
  file_name: string | null
  token_salt: string | null
  expires_at: string | null
  error: string | null
  trigger_source: "scheduler" | "manual"
  started_at: string
  finished_at: string | null
}

function toPublicRun(row: RunRow): ReportScheduleRun {
  const downloadUrl =
    row.status === "success" && row.channel === "storage"
      ? buildRunDownloadPath({ id: row.id, tenantId: row.tenant_id, tokenSalt: row.token_salt, expiresAt: row.expires_at })
      : null
  return {
    id: Number(row.id),
    scheduleId: Number(row.schedule_id),
    status: (row.status === "running" ? "failed" : row.status) as ReportScheduleRun["status"],
    format: row.format,
    channel: row.channel,
    rowCount: Number(row.row_count),
    byteSize: Number(row.byte_size),
    recipientsCount: Number(row.recipients_count),
    fileName: row.file_name,
    error: row.error,
    triggerSource: row.trigger_source,
    downloadUrl,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

export async function listReportScheduleRuns(
  tenantId: number | null,
  scheduleId: number,
  limit = 20,
): Promise<ReportScheduleRun[]> {
  await ensureReportSchedulerSchema()
  const safe = Math.min(SCHEDULER_CAPS.maxRunHistory, Math.max(1, Math.floor(Number(limit) || 20)))
  const rows = await query<RunRow[]>(
    `SELECT id, schedule_id, tenant_id, status, format, channel, row_count, byte_size, recipients_count,
            file_name, token_salt, expires_at, error, trigger_source, started_at, finished_at
       FROM report_schedule_runs
      WHERE schedule_id = ? AND tenant_id <=> ?
      ORDER BY started_at DESC
      LIMIT ${safe}`,
    [scheduleId, tenantId],
  )
  return rows.map(toPublicRun)
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Claim a per-minute slot for a schedule. Returns the new run id, or null when
 * the slot is already taken (idempotent across parallel dispatcher workers).
 */
async function claimRunSlot(
  schedule: ReportSchedule,
  slot: string,
  triggerSource: "scheduler" | "manual",
  now: Date,
): Promise<number | null> {
  return withTransaction(async (connection) => {
    try {
      const [res] = await connection.query<any>(
        `INSERT INTO report_schedule_runs
           (schedule_id, tenant_id, slot, status, format, channel, trigger_source, started_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
        [schedule.id, schedule.tenantId, slot, schedule.format, schedule.channel, triggerSource, now],
      )
      return Number(res.insertId)
    } catch (error: any) {
      if (error?.code === "ER_DUP_ENTRY") return null
      throw error
    }
  })
}

async function finalizeRunFailure(runId: number, message: string) {
  await query(
    `UPDATE report_schedule_runs SET status='failed', error=?, finished_at=NOW() WHERE id=?`,
    [message.slice(0, 2000), runId],
  )
}

/**
 * Execute one schedule: re-run its report under the creator's role, serialize
 * to the chosen format, then deliver. Never throws for an expected operational
 * failure (empty report is allowed; oversized artifact / delivery error are
 * captured on the run row) — it returns the terminal status instead so the cron
 * sweep can keep going. Unexpected errors are also caught and recorded.
 */
export async function executeReportSchedule(
  schedule: ReportSchedule,
  opts: { triggerSource: "scheduler" | "manual"; now?: Date } = { triggerSource: "scheduler" },
): Promise<{ status: "success" | "failed" | "skipped"; runId: number | null; error?: string }> {
  await ensureReportSchedulerSchema()
  const now = opts.now ?? new Date()
  const slot = slotKey(now)

  const runId = await claimRunSlot(schedule, slot, opts.triggerSource, now)
  if (runId == null) return { status: "skipped", runId: null }

  try {
    const report = await getReport(schedule.tenantId, schedule.reportId)
    if (!report) {
      await finalizeRunFailure(runId, "The linked report no longer exists.")
      return { status: "failed", runId, error: "report-missing" }
    }

    // Phase 1: run through the same permission-aware builder as manual exports.
    // Schedules are always created by a tenant admin (see requireTenantAdmin in
    // the routes), so runs execute with that role's data scope, and — per
    // SPEC 99 — under the CREATOR's user id so row-level scope (User / Team /
    // Entity / Branch) and field-level protection are applied to the delivered
    // artifact exactly as they would be for an interactive run.
    const role: TenantRole = "tenant_admin"
    const result = await runReport(report.definition, {
      tenantId: schedule.tenantId,
      role,
      userId: schedule.createdBy ?? 0,
    })

    const fileName = reportArtifactFileName(schedule.reportName, schedule.format, now)
    const { bytes, contentType } = await serializeArtifact(schedule.format, schedule.reportName, result)

    // Large-report guard: fail cleanly instead of overflowing storage / mail.
    if (bytes.length > SCHEDULER_CAPS.maxArtifactBytes) {
      const message = `Report is too large to deliver (${(bytes.length / (1024 * 1024)).toFixed(1)} MB, limit ${(SCHEDULER_CAPS.maxArtifactBytes / (1024 * 1024)).toFixed(0)} MB). Add filters or narrow the date range.`
      await finalizeRunFailure(runId, message)
      await touchScheduleLastRun(schedule, now, "failed")
      return { status: "failed", runId, error: message }
    }

    if (schedule.channel === "email") {
      await deliverByEmail(schedule, fileName, bytes, contentType)
      await query(
        `UPDATE report_schedule_runs
            SET status='success', row_count=?, byte_size=?, recipients_count=?, file_name=?, content_type=?, finished_at=NOW()
          WHERE id=?`,
        [result.rows.length, bytes.length, schedule.recipients.length, fileName, contentType, runId],
      )
    } else {
      const salt = randomBytes(18).toString("hex")
      const expiresAt = new Date(now.getTime() + SCHEDULER_CAPS.downloadTtlMs)
      await query(
        `UPDATE report_schedule_runs
            SET status='success', row_count=?, byte_size=?, file_name=?, content_type=?, artifact=?, token_salt=?, expires_at=?, finished_at=NOW()
          WHERE id=?`,
        [result.rows.length, bytes.length, fileName, contentType, bytes, salt, expiresAt, runId],
      )
    }

    await touchScheduleLastRun(schedule, now, "success")
    return { status: "success", runId }
  } catch (error) {
    const message = (error as Error)?.message || "Report delivery failed."
    await finalizeRunFailure(runId, message)
    await touchScheduleLastRun(schedule, now, "failed")
    return { status: "failed", runId, error: message }
  }
}

async function touchScheduleLastRun(schedule: ReportSchedule, now: Date, status: string) {
  await query(`UPDATE report_schedules SET last_run_at=?, last_status=? WHERE id=?`, [now, status, schedule.id]).catch(() => {})
}

async function deliverByEmail(schedule: ReportSchedule, fileName: string, bytes: Buffer, contentType: string) {
  if (schedule.recipients.length === 0) throw new Error("No recipients configured for email delivery.")
  const attachment: OutgoingAttachment = { filename: fileName, content: bytes, contentType }
  const subject = `Scheduled report: ${schedule.reportName}`
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#111827">
      <p>Your scheduled report <strong>${escapeHtml(schedule.reportName)}</strong> is attached.</p>
      <p style="color:#6b7280;font-size:12px">Schedule: ${escapeHtml(schedule.description)} · Format: ${schedule.format.toUpperCase()}</p>
      <p style="color:#6b7280;font-size:12px">This is an automated delivery from the Muenot ERP report scheduler.</p>
    </div>`
  await sendEmail({
    to: schedule.recipients.join(", "),
    subject,
    html,
    department: "finance",
    attachments: [attachment],
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string)
}

/**
 * Manual "Run now" — bypasses cron matching but still honours slot idempotency
 * within the minute, so double-clicks don't double-deliver.
 */
export async function runReportScheduleNow(
  tenantId: number | null,
  id: number,
): Promise<{ status: "success" | "failed" | "skipped"; error?: string } | null> {
  const schedule = await getReportSchedule(tenantId, id)
  if (!schedule) return null
  const { status, error } = await executeReportSchedule(schedule, { triggerSource: "manual" })
  return { status, error }
}

/**
 * Cron entrypoint: run every due, active schedule across all tenants. A schedule
 * is due when its cron expression matches the current minute in its timezone.
 * Per-schedule failures are isolated so one bad report can't stall the sweep.
 */
export async function runDueReportSchedules(now: Date = new Date()): Promise<{ ran: number; failed: number; skipped: number }> {
  await ensureReportSchedulerSchema()
  const rows = await query<ScheduleRow[]>(`${SCHEDULE_SELECT} WHERE s.status = 'active'`, [])
  let ran = 0
  let failed = 0
  let skipped = 0
  for (const row of rows) {
    const schedule = toPublicSchedule(row)
    if (!matchesCronExpression(schedule.cronExpression, now, schedule.timezone)) continue
    try {
      const res = await executeReportSchedule(schedule, { triggerSource: "scheduler", now })
      if (res.status === "success") ran++
      else if (res.status === "skipped") skipped++
      else failed++
    } catch {
      failed++
    }
  }
  return { ran, failed, skipped }
}

// ---------------------------------------------------------------------------
// Secure download (storage delivery)
// ---------------------------------------------------------------------------

export async function resolveScheduleDownload(
  tenantId: number | null,
  runId: number,
  exp: number,
  sig: string,
): Promise<{ ok: true; bytes: Buffer; fileName: string; contentType: string } | { ok: false; status: number; reason: string }> {
  await ensureReportSchedulerSchema()
  const rows = await query<any[]>(
    `SELECT id, tenant_id, status, channel, file_name, content_type, token_salt, expires_at, artifact
       FROM report_schedule_runs WHERE id = ? AND tenant_id <=> ? LIMIT 1`,
    [runId, tenantId],
  )
  const row = rows[0]
  if (!row) return { ok: false, status: 404, reason: "Not found" }
  if (row.status !== "success" || row.channel !== "storage" || !row.artifact) {
    return { ok: false, status: 404, reason: "No artifact available" }
  }
  const check = verifyToken(
    { id: row.id, tenantId: row.tenant_id, tokenSalt: row.token_salt, expiresAt: row.expires_at },
    exp,
    sig,
  )
  if (!check.valid) {
    const status = check.reason === "expired" ? 410 : 403
    return { ok: false, status, reason: check.reason ?? "Invalid token" }
  }
  const bytes = Buffer.isBuffer(row.artifact) ? row.artifact : Buffer.from(row.artifact)
  return { ok: true, bytes, fileName: row.file_name || "report", contentType: row.content_type || "application/octet-stream" }
}
