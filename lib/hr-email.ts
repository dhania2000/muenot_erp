import crypto from "crypto"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import {
  generateTrackingToken,
  isEmailConfigured,
  loadAttachment,
  renderTemplate,
  sendEmail,
  withTrackingPixel,
} from "@/lib/email"

/**
 * Central service for the HR Email Hub. Every HR email — whether composed by a
 * user, sent immediately, saved as a draft, scheduled for later, or fired
 * automatically by another HR module — flows through here so it lands in one
 * table (`hr_emails`) with a stable Email ID, tracking, and full lifecycle
 * bookkeeping. Reuses the proven transport layer in lib/email.ts.
 */

export {
  HR_EMAIL_CATEGORIES,
  SENSITIVE_HR_EMAIL_CATEGORIES,
  HR_EMAIL_STATUSES,
} from "@/lib/hr-email-shared"
export type { HrEmailCategory, HrEmailStatus } from "@/lib/hr-email-shared"

import type { HrEmailStatus } from "@/lib/hr-email-shared"

const MAX_SEND_ATTEMPTS = 5

// ---------------------------------------------------------------------------
// Self-healing schema (mirrors lib/email.ts) so the hub works even when the
// SQL migration has not been run manually.
// ---------------------------------------------------------------------------
let schemaEnsured = false

async function ensureColumn(table: string, column: string, definition: string) {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  if (rows.length === 0) {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
  }
}

async function ensureIndex(table: string, indexName: string, definition: string) {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, indexName],
  )
  if (rows.length === 0) {
    await query(`ALTER TABLE \`${table}\` ADD ${definition}`)
  }
}

export async function ensureHrEmailHubSchema() {
  if (schemaEnsured) return
  // The base table is created by earlier migrations; guard anyway.
  await query(
    `CREATE TABLE IF NOT EXISTS hr_emails (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      employee_id BIGINT UNSIGNED NULL,
      to_email VARCHAR(190) NOT NULL,
      to_name VARCHAR(150) NULL,
      template_id BIGINT UNSIGNED NULL,
      subject VARCHAR(255) NOT NULL,
      body LONGTEXT NOT NULL,
      status ENUM('Sent','Failed','Draft') NOT NULL DEFAULT 'Sent',
      message_id VARCHAR(255) NULL,
      thread_id VARCHAR(255) NULL,
      opened_at DATETIME NULL,
      open_count INT NOT NULL DEFAULT 0,
      sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by BIGINT UNSIGNED NULL,
      INDEX idx_hr_emails_employee (employee_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await ensureColumn("hr_emails", "email_uid", "VARCHAR(40) NULL")
  await ensureColumn("hr_emails", "category", "VARCHAR(60) NOT NULL DEFAULT 'General'")
  await ensureColumn("hr_emails", "source_module", "VARCHAR(40) NOT NULL DEFAULT 'manual'")
  await ensureColumn("hr_emails", "source_record_id", "VARCHAR(64) NULL")
  await ensureColumn("hr_emails", "cc", "TEXT NULL")
  await ensureColumn("hr_emails", "bcc", "TEXT NULL")
  await ensureColumn("hr_emails", "email_type", "ENUM('Manual','Automated') NOT NULL DEFAULT 'Manual'")
  await ensureColumn("hr_emails", "scheduled_at", "DATETIME NULL")
  await ensureColumn("hr_emails", "attempts", "INT UNSIGNED NOT NULL DEFAULT 0")
  await ensureColumn("hr_emails", "last_error", "VARCHAR(500) NULL")
  await ensureColumn("hr_emails", "dedupe_key", "VARCHAR(190) NULL")
  await ensureColumn("hr_emails", "attachment_pathname", "VARCHAR(255) NULL")
  await ensureColumn("hr_emails", "attachment_name", "VARCHAR(255) NULL")
  await ensureColumn("hr_emails", "attachment_type", "VARCHAR(150) NULL")
  await ensureColumn("hr_emails", "attachment_size", "INT UNSIGNED NULL")
  await ensureColumn(
    "hr_emails",
    "updated_at",
    "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
  )

  // Expand the status ENUM to the full lifecycle (safe to run repeatedly).
  await query(
    `ALTER TABLE hr_emails MODIFY COLUMN status
     ENUM('Draft','Scheduled','Queued','Sending','Sent','Failed','Cancelled')
     NOT NULL DEFAULT 'Sent'`,
  )

  await ensureIndex("hr_emails", "uq_hr_emails_uid", "UNIQUE KEY uq_hr_emails_uid (email_uid)")
  await ensureIndex("hr_emails", "uq_hr_emails_dedupe", "UNIQUE KEY uq_hr_emails_dedupe (dedupe_key)")
  await ensureIndex("hr_emails", "idx_hr_emails_status", "KEY idx_hr_emails_status (status)")
  await ensureIndex("hr_emails", "idx_hr_emails_category", "KEY idx_hr_emails_category (category)")
  await ensureIndex("hr_emails", "idx_hr_emails_queue", "KEY idx_hr_emails_queue (status, scheduled_at)")

  schemaEnsured = true
}

// ---------------------------------------------------------------------------
// Recipient resolution + variable rendering
// ---------------------------------------------------------------------------
export type ResolvedRecipient = {
  email: string
  name: string | null
  vars: Record<string, string>
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(value: string | null | undefined): boolean {
  return !!value && EMAIL_RE.test(value.trim())
}

/** Normalize a comma/semicolon/newline separated recipient list into clean emails. */
export function parseAddressList(raw: string | null | undefined): string[] {
  if (!raw) return []
  return Array.from(
    new Set(
      raw
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  )
}

/** Build the {{variable}} map available to subject/body from an employee row. */
function buildEmployeeVars(emp: Record<string, any>): Record<string, string> {
  const val = (v: any) => (v == null ? "" : String(v))
  return {
    employee_name: val(emp.employee_name),
    employee_id: val(emp.employee_id),
    first_name: val(emp.employee_name).split(" ")[0] || "",
    email: val(emp.official_email || emp.personal_email),
    official_email: val(emp.official_email),
    personal_email: val(emp.personal_email),
    department: val(emp.department),
    designation: val(emp.designation),
    reporting_manager: val(emp.reporting_manager),
    joining_date: val(emp.joining_date),
    mobile: val(emp.mobile),
    work_location: val(emp.work_location),
  }
}

/**
 * Resolve an employee (by numeric primary key) into a deliverable recipient.
 * Prefers the official email, falls back to personal. Returns null when the
 * employee has no usable email.
 */
export async function resolveEmployeeRecipient(
  employeeId: number,
): Promise<ResolvedRecipient | null> {
  const rows = await query<any[]>(
    `SELECT id, employee_id, employee_name, official_email, personal_email, department,
            designation, reporting_manager, joining_date, mobile, work_location
     FROM hr_employees WHERE id = ? LIMIT 1`,
    [employeeId],
  )
  const emp = rows[0]
  if (!emp) return null
  const email = (emp.official_email || emp.personal_email || "").trim()
  if (!isValidEmail(email)) return null
  return { email, name: emp.employee_name || null, vars: buildEmployeeVars(emp) }
}

/** Deterministic idempotency key so an automated event never emails twice. */
export function buildDedupeKey(...parts: (string | number | null | undefined)[]): string {
  const basis = parts.map((p) => (p == null ? "" : String(p))).join("|")
  return crypto.createHash("sha1").update(basis).digest("hex")
}

// ---------------------------------------------------------------------------
// Create / send
// ---------------------------------------------------------------------------
export type CreateHrEmailInput = {
  employeeId?: number | null
  toEmail?: string | null
  toName?: string | null
  cc?: string | null
  bcc?: string | null
  subject: string
  body: string
  templateId?: number | null
  category?: string
  sourceModule?: string
  sourceRecordId?: string | null
  emailType?: "Manual" | "Automated"
  /** ISO string or MySQL DATETIME for scheduled sends. */
  scheduledAt?: string | null
  mode: "send" | "draft" | "schedule"
  createdBy?: number | null
  dedupeKey?: string | null
  attachment?: {
    pathname?: string | null
    filename?: string | null
    contentType?: string | null
    size?: number | null
  } | null
  /** When true, {{vars}} in subject/body are rendered from the employee. */
  render?: boolean
}

export type CreateHrEmailResult =
  | { ok: true; id: number; emailUid: string; status: HrEmailStatus; deduped?: boolean }
  | { ok: false; error: string; code?: number }

/** Convert an ISO / datetime-local string into a MySQL DATETIME, or null. */
function toMysqlDateTime(value: string | null | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 19).replace("T", " ")
}

async function generateEmailUid(): Promise<string> {
  const raw = await nextRecordId("HRE", { digits: 6 })
  const seq = raw.split("-")[1] ?? "000000"
  return `HRE-${new Date().getFullYear()}-${seq}`
}

/**
 * Create an HR email record and, for `mode: "send"`, dispatch it immediately.
 * Draft/schedule modes only persist the record for the dispatcher to pick up.
 */
export async function createHrEmail(input: CreateHrEmailInput): Promise<CreateHrEmailResult> {
  await ensureHrEmailHubSchema()

  const category = (input.category || "General").trim() || "General"
  const sourceModule = (input.sourceModule || "manual").trim() || "manual"
  const emailType = input.emailType || "Manual"

  // Resolve recipient + rendering variables.
  let toEmail = (input.toEmail || "").trim()
  let toName = input.toName ?? null
  let vars: Record<string, string> = {}
  if (input.employeeId) {
    const resolved = await resolveEmployeeRecipient(input.employeeId)
    if (!resolved) {
      return { ok: false, error: "Selected employee has no valid email address", code: 400 }
    }
    if (!toEmail) toEmail = resolved.email
    if (!toName) toName = resolved.name
    vars = resolved.vars
  }

  if (!isValidEmail(toEmail)) {
    return { ok: false, error: "A valid recipient email is required", code: 400 }
  }

  const cc = parseAddressList(input.cc)
  const bcc = parseAddressList(input.bcc)
  const badCc = [...cc, ...bcc].find((a) => !isValidEmail(a))
  if (badCc) return { ok: false, error: `Invalid CC/BCC address: ${badCc}`, code: 400 }

  let subject = (input.subject || "").trim()
  let bodyHtml = input.body || ""
  if (input.render !== false && input.employeeId) {
    subject = renderTemplate(subject, vars)
    bodyHtml = renderTemplate(bodyHtml, vars)
  }
  if (!subject) return { ok: false, error: "Subject is required", code: 400 }
  if (!bodyHtml.trim()) return { ok: false, error: "Body is required", code: 400 }

  const scheduledAt = input.mode === "schedule" ? toMysqlDateTime(input.scheduledAt) : null
  if (input.mode === "schedule" && !scheduledAt) {
    return { ok: false, error: "A valid future date/time is required to schedule", code: 400 }
  }

  // Idempotency: if a non-terminal row already exists for this dedupe key, reuse it.
  if (input.dedupeKey) {
    const existing = await query<any[]>(
      `SELECT id, email_uid, status FROM hr_emails
       WHERE dedupe_key = ? AND status NOT IN ('Failed','Cancelled') LIMIT 1`,
      [input.dedupeKey],
    )
    if (existing[0]) {
      return {
        ok: true,
        id: Number(existing[0].id),
        emailUid: existing[0].email_uid,
        status: existing[0].status,
        deduped: true,
      }
    }
  }

  const initialStatus: HrEmailStatus =
    input.mode === "draft" ? "Draft" : input.mode === "schedule" ? "Scheduled" : "Sending"

  // A tracking token doubles as thread_id so the existing
  // /api/hr/emails/track/[id] pixel endpoint keeps working unchanged.
  const trackingToken = generateTrackingToken()
  const emailUid = await generateEmailUid()

  const result = await query<any>(
    `INSERT INTO hr_emails
      (email_uid, employee_id, to_email, to_name, cc, bcc, template_id, subject, body,
       category, source_module, source_record_id, email_type, status, scheduled_at,
       thread_id, dedupe_key, attachment_pathname, attachment_name, attachment_type,
       attachment_size, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      emailUid,
      input.employeeId || null,
      toEmail,
      toName,
      cc.length ? cc.join(", ") : null,
      bcc.length ? bcc.join(", ") : null,
      input.templateId || null,
      subject,
      bodyHtml,
      category,
      sourceModule,
      input.sourceRecordId || null,
      emailType,
      initialStatus,
      scheduledAt,
      trackingToken,
      input.dedupeKey || null,
      input.attachment?.pathname || null,
      input.attachment?.filename || null,
      input.attachment?.contentType || null,
      input.attachment?.size || null,
      input.createdBy || null,
    ],
  )
  const id = Number(result.insertId)

  if (input.mode !== "send") {
    return { ok: true, id, emailUid, status: initialStatus }
  }

  const sent = await sendHrEmailRow(id)
  return { ok: true, id, emailUid, status: sent.status }
}

/**
 * Send (or retry) a single hr_emails row by id. Loads the stored content,
 * dispatches through the HR transport, and records the outcome + attempt count.
 */
export async function sendHrEmailRow(
  id: number,
): Promise<{ status: HrEmailStatus; error?: string }> {
  await ensureHrEmailHubSchema()

  const rows = await query<any[]>("SELECT * FROM hr_emails WHERE id = ? LIMIT 1", [id])
  const row = rows[0]
  if (!row) return { status: "Failed", error: "Email not found" }
  if (row.status === "Sent") return { status: "Sent" }
  if (row.status === "Cancelled") return { status: "Cancelled" }

  if (!isEmailConfigured("hr")) {
    await query("UPDATE hr_emails SET status='Failed', last_error=? WHERE id=?", [
      "HR email transport is not configured",
      id,
    ])
    return { status: "Failed", error: "HR email transport is not configured" }
  }

  await query("UPDATE hr_emails SET status='Sending' WHERE id=?", [id])

  const baseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
  const token = row.thread_id || generateTrackingToken()
  const trackedBody = withTrackingPixel(row.body, baseUrl.replace(/\/$/, ""), token).replace(
    `/api/track/${token}`,
    `/api/hr/emails/track/${token}`,
  )

  const attachments = []
  if (row.attachment_pathname) {
    const file = await loadAttachment(row.attachment_pathname)
    if (file) attachments.push(file)
  }

  try {
    const res = await sendEmail({
      to: row.to_email,
      cc: row.cc || undefined,
      bcc: row.bcc || undefined,
      subject: row.subject,
      html: trackedBody,
      department: "hr",
      attachments: attachments.length ? attachments : undefined,
    })
    await query(
      `UPDATE hr_emails
       SET status='Sent', message_id=?, thread_id=?, attempts=attempts+1,
           last_error=NULL, sent_at=NOW()
       WHERE id=?`,
      [res.messageId || null, token, id],
    )
    return { status: "Sent" }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send email"
    const attempts = Number(row.attempts || 0) + 1
    // Terminal Failed once we exhaust retries; otherwise re-queue for the
    // dispatcher (scheduled/queued rows retry on the next run).
    const requeue = row.status === "Scheduled" || row.status === "Queued" || row.scheduled_at
    const nextStatus: HrEmailStatus =
      attempts >= MAX_SEND_ATTEMPTS ? "Failed" : requeue ? "Queued" : "Failed"
    await query(
      "UPDATE hr_emails SET status=?, attempts=?, last_error=?, thread_id=? WHERE id=?",
      [nextStatus, attempts, message.slice(0, 500), token, id],
    )
    return { status: nextStatus, error: message }
  }
}

/**
 * Dispatch every HR email that is due: scheduled rows whose time has arrived,
 * plus queued retries. Idempotent — safe to call from a cron on any interval.
 */
export async function dispatchDueHrEmails(
  limit = 25,
): Promise<{ processed: number; sent: number; failed: number }> {
  await ensureHrEmailHubSchema()
  const due = await query<any[]>(
    `SELECT id FROM hr_emails
     WHERE status IN ('Scheduled','Queued')
       AND (scheduled_at IS NULL OR scheduled_at <= NOW())
       AND attempts < ?
     ORDER BY COALESCE(scheduled_at, sent_at) ASC, id ASC
     LIMIT ?`,
    [MAX_SEND_ATTEMPTS, limit],
  )
  let sent = 0
  let failed = 0
  for (const { id } of due) {
    const res = await sendHrEmailRow(Number(id))
    if (res.status === "Sent") sent++
    else if (res.status === "Failed") failed++
  }
  return { processed: due.length, sent, failed }
}
