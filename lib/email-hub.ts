import "server-only"
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
import type { EmailHubModuleKey, EmailHubStatus } from "@/lib/email-hub-shared"

/**
 * Config-driven service that powers the Operations and Recruitment Email Hubs.
 * It mirrors the proven HR Email Hub (lib/hr-email.ts) — single table per
 * module, stable Email ID, tracking pixel, full Draft→Scheduled→Sent lifecycle,
 * dispatcher, analytics and an automation catalog — but is parameterized by a
 * `HubBackend` so both modules share one implementation instead of duplicating
 * the HR code twice. The working HR hub is left completely untouched.
 */

const MAX_SEND_ATTEMPTS = 5
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type HubResolvedRecipient = {
  email: string
  name: string | null
  vars: Record<string, string>
}

export type HubRecipientRow = {
  id: string
  ref: string
  name: string
  email: string
  meta: string | null
  sub: string | null
}

export type HubAutomationEvent = {
  key: string
  label: string
  group: string
  description: string
  category: string
  defaultSubject: string
  variables: string[]
}

export type HubBackend = {
  key: EmailHubModuleKey
  table: string
  automationTable: string
  uidPrefix: string
  /** Transport department key understood by lib/email.ts. */
  department: "operations" | "recruit"
  categories: string[]
  sensitiveCategories: Set<string>
  events: HubAutomationEvent[]
  listRecipients: (search: string) => Promise<HubRecipientRow[]>
  resolveRecipient: (id: string) => Promise<HubResolvedRecipient | null>
}

// ---------------------------------------------------------------------------
// Recipient helpers (module-specific)
// ---------------------------------------------------------------------------
export function isValidEmail(value: string | null | undefined): boolean {
  return !!value && EMAIL_RE.test(value.trim())
}

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

const val = (v: any) => (v == null ? "" : String(v))

async function listEmployeeRecipients(search: string): Promise<HubRecipientRow[]> {
  const q = `%${search.trim()}%`
  const rows = await query<any[]>(
    `SELECT id, employee_id, employee_name, official_email, personal_email, department, designation
     FROM hr_employees
     WHERE (? = '%%' OR employee_name LIKE ? OR employee_id LIKE ? OR official_email LIKE ?
            OR personal_email LIKE ? OR department LIKE ?)
       AND (official_email IS NOT NULL OR personal_email IS NOT NULL)
     ORDER BY employee_name ASC
     LIMIT 50`,
    [q, q, q, q, q, q],
  ).catch(() => [] as any[])
  return rows
    .map((r) => ({
      id: String(r.id),
      ref: val(r.employee_id),
      name: val(r.employee_name) || val(r.official_email),
      email: val(r.official_email || r.personal_email),
      meta: r.department ? String(r.department) : null,
      sub: r.designation ? String(r.designation) : null,
    }))
    .filter((r) => isValidEmail(r.email))
}

async function resolveEmployeeRecipient(id: string): Promise<HubResolvedRecipient | null> {
  const rows = await query<any[]>(
    `SELECT id, employee_id, employee_name, official_email, personal_email, department,
            designation, reporting_manager
     FROM hr_employees WHERE id = ? LIMIT 1`,
    [id],
  ).catch(() => [] as any[])
  const emp = rows[0]
  if (!emp) return null
  const email = (emp.official_email || emp.personal_email || "").trim()
  if (!isValidEmail(email)) return null
  return {
    email,
    name: emp.employee_name || null,
    vars: {
      employee_name: val(emp.employee_name),
      first_name: val(emp.employee_name).split(" ")[0] || "",
      employee_id: val(emp.employee_id),
      department: val(emp.department),
      designation: val(emp.designation),
      reporting_manager: val(emp.reporting_manager),
      email,
    },
  }
}

async function listCandidateRecipients(search: string): Promise<HubRecipientRow[]> {
  const q = `%${search.trim()}%`
  const rows = await query<any[]>(
    `SELECT candidate_id, candidate_name, email, job_applied, application_id
     FROM recruitment_candidates
     WHERE email IS NOT NULL AND email <> ''
       AND (? = '%%' OR candidate_name LIKE ? OR email LIKE ? OR job_applied LIKE ?
            OR candidate_id LIKE ?)
     ORDER BY candidate_name ASC
     LIMIT 50`,
    [q, q, q, q, q],
  ).catch(() => [] as any[])
  return rows
    .map((r) => ({
      id: val(r.candidate_id),
      ref: val(r.candidate_id),
      name: val(r.candidate_name) || val(r.email),
      email: val(r.email),
      meta: r.job_applied ? String(r.job_applied) : null,
      sub: r.application_id ? String(r.application_id) : null,
    }))
    .filter((r) => isValidEmail(r.email))
}

async function resolveCandidateRecipient(id: string): Promise<HubResolvedRecipient | null> {
  const rows = await query<any[]>(
    `SELECT candidate_id, candidate_name, email, mobile, job_applied, application_id, current_stage
     FROM recruitment_candidates WHERE candidate_id = ? LIMIT 1`,
    [id],
  ).catch(() => [] as any[])
  const c = rows[0]
  if (!c) return null
  const email = (c.email || "").trim()
  if (!isValidEmail(email)) return null
  return {
    email,
    name: c.candidate_name || null,
    vars: {
      candidate_name: val(c.candidate_name),
      first_name: val(c.candidate_name).split(" ")[0] || "",
      email,
      job_applied: val(c.job_applied),
      application_id: val(c.application_id),
      stage: val(c.current_stage),
    },
  }
}

// ---------------------------------------------------------------------------
// Automation catalogs (per module)
// ---------------------------------------------------------------------------
const OPERATIONS_EVENTS: HubAutomationEvent[] = [
  {
    key: "task_assigned",
    label: "Task assigned",
    group: "Delivery",
    description: "Notify the owner when a task is assigned to them.",
    category: "Task",
    defaultSubject: "New task assigned: {{task_name}}",
    variables: ["employee_name", "task_name", "project_name", "due_date"],
  },
  {
    key: "task_overdue",
    label: "Task overdue",
    group: "Delivery",
    description: "Alert the owner and manager when a task passes its due date.",
    category: "Task",
    defaultSubject: "Task overdue: {{task_name}}",
    variables: ["employee_name", "task_name", "project_name", "due_date"],
  },
  {
    key: "milestone_due",
    label: "Milestone due",
    group: "Delivery",
    description: "Remind the team ahead of an upcoming project milestone.",
    category: "Milestone",
    defaultSubject: "Milestone due soon: {{milestone_name}}",
    variables: ["employee_name", "milestone_name", "project_name", "due_date"],
  },
  {
    key: "deliverable_submitted",
    label: "Deliverable submitted",
    group: "Approvals",
    description: "Notify the approver when a deliverable is submitted for review.",
    category: "Deliverable",
    defaultSubject: "Deliverable ready for review: {{deliverable_name}}",
    variables: ["employee_name", "deliverable_name", "project_name"],
  },
  {
    key: "issue_raised",
    label: "Issue raised",
    group: "Risk",
    description: "Alert the project lead when a new issue is logged.",
    category: "Issue",
    defaultSubject: "New issue raised on {{project_name}}",
    variables: ["employee_name", "issue_title", "project_name", "priority"],
  },
  {
    key: "sla_breach",
    label: "SLA breach",
    group: "Risk",
    description: "Escalate to management when an SLA is breached.",
    category: "SLA",
    defaultSubject: "SLA breach alert: {{project_name}}",
    variables: ["employee_name", "project_name", "sla_name"],
  },
]

const RECRUIT_EVENTS: HubAutomationEvent[] = [
  {
    key: "application_received",
    label: "Application received",
    group: "Pipeline",
    description: "Acknowledge a candidate as soon as they apply.",
    category: "Application",
    defaultSubject: "We received your application for {{job_applied}}",
    variables: ["candidate_name", "job_applied"],
  },
  {
    key: "screening_scheduled",
    label: "Screening scheduled",
    group: "Pipeline",
    description: "Confirm a screening call with the candidate.",
    category: "Screening",
    defaultSubject: "Your screening call for {{job_applied}}",
    variables: ["candidate_name", "job_applied", "interview_date"],
  },
  {
    key: "interview_scheduled",
    label: "Interview scheduled",
    group: "Interviews",
    description: "Send interview details when an interview is booked.",
    category: "Interview",
    defaultSubject: "Interview scheduled for {{job_applied}}",
    variables: ["candidate_name", "job_applied", "interview_date", "interview_mode"],
  },
  {
    key: "interview_reminder",
    label: "Interview reminder",
    group: "Interviews",
    description: "Remind the candidate ahead of their interview.",
    category: "Interview",
    defaultSubject: "Reminder: your interview for {{job_applied}}",
    variables: ["candidate_name", "job_applied", "interview_date"],
  },
  {
    key: "offer_released",
    label: "Offer released",
    group: "Offer",
    description: "Notify the candidate that an offer has been extended.",
    category: "Offer",
    defaultSubject: "Your offer from Muenot Technologies",
    variables: ["candidate_name", "job_applied"],
  },
  {
    key: "application_rejected",
    label: "Application rejected",
    group: "Pipeline",
    description: "Send a respectful regret note when a candidate is not moving forward.",
    category: "Rejection",
    defaultSubject: "Update on your application for {{job_applied}}",
    variables: ["candidate_name", "job_applied"],
  },
  {
    key: "onboarding_started",
    label: "Onboarding started",
    group: "Onboarding",
    description: "Welcome a candidate when onboarding begins.",
    category: "Onboarding",
    defaultSubject: "Welcome aboard, {{first_name}}!",
    variables: ["candidate_name", "first_name", "job_applied"],
  },
]

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------
export const OPERATIONS_HUB: HubBackend = {
  key: "operations",
  table: "operations_hub_emails",
  automationTable: "operations_hub_email_automations",
  uidPrefix: "OPE",
  department: "operations",
  categories: [
    "General",
    "Project",
    "Client",
    "Task",
    "Deliverable",
    "Milestone",
    "Issue",
    "SLA",
    "Approval",
    "Escalation",
  ],
  sensitiveCategories: new Set(["Escalation"]),
  events: OPERATIONS_EVENTS,
  listRecipients: listEmployeeRecipients,
  resolveRecipient: resolveEmployeeRecipient,
}

export const RECRUIT_HUB: HubBackend = {
  key: "recruit",
  table: "recruit_hub_emails",
  automationTable: "recruit_hub_email_automations",
  uidPrefix: "RCE",
  department: "recruit",
  categories: [
    "General",
    "Application",
    "Screening",
    "Interview",
    "Assessment",
    "Offer",
    "Onboarding",
    "Rejection",
    "Follow-up",
  ],
  sensitiveCategories: new Set(["Offer", "Rejection"]),
  events: RECRUIT_EVENTS,
  listRecipients: listCandidateRecipients,
  resolveRecipient: resolveCandidateRecipient,
}

export function getHubBackend(key: string): HubBackend | null {
  if (key === "operations") return OPERATIONS_HUB
  if (key === "recruit") return RECRUIT_HUB
  return null
}

// ---------------------------------------------------------------------------
// Self-healing schema (mirrors lib/hr-email.ts)
// ---------------------------------------------------------------------------
const ensuredTables = new Set<string>()

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

export async function ensureHubSchema(backend: HubBackend) {
  if (ensuredTables.has(backend.table)) return
  await query(
    `CREATE TABLE IF NOT EXISTS \`${backend.table}\` (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email_uid VARCHAR(40) NULL,
      recipient_ref VARCHAR(64) NULL,
      to_email VARCHAR(190) NOT NULL,
      to_name VARCHAR(190) NULL,
      cc TEXT NULL,
      bcc TEXT NULL,
      template_id BIGINT UNSIGNED NULL,
      subject VARCHAR(255) NOT NULL,
      body LONGTEXT NOT NULL,
      category VARCHAR(60) NOT NULL DEFAULT 'General',
      source_module VARCHAR(40) NOT NULL DEFAULT 'manual',
      source_record_id VARCHAR(64) NULL,
      email_type ENUM('Manual','Automated') NOT NULL DEFAULT 'Manual',
      status ENUM('Draft','Scheduled','Queued','Sending','Sent','Failed','Cancelled') NOT NULL DEFAULT 'Sent',
      message_id VARCHAR(255) NULL,
      thread_id VARCHAR(255) NULL,
      scheduled_at DATETIME NULL,
      opened_at DATETIME NULL,
      open_count INT NOT NULL DEFAULT 0,
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      last_error VARCHAR(500) NULL,
      dedupe_key VARCHAR(190) NULL,
      attachment_pathname VARCHAR(255) NULL,
      attachment_name VARCHAR(255) NULL,
      attachment_type VARCHAR(150) NULL,
      attachment_size INT UNSIGNED NULL,
      created_by BIGINT UNSIGNED NULL,
      sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_${backend.key}_hub_status (status),
      INDEX idx_${backend.key}_hub_category (category),
      INDEX idx_${backend.key}_hub_queue (status, scheduled_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  // Guard columns for pre-existing tables.
  await ensureColumn(backend.table, "recipient_ref", "VARCHAR(64) NULL")
  await ensureColumn(backend.table, "open_count", "INT NOT NULL DEFAULT 0")
  await ensureColumn(backend.table, "opened_at", "DATETIME NULL")
  await ensureIndex(
    backend.table,
    `uq_${backend.key}_hub_uid`,
    `UNIQUE KEY uq_${backend.key}_hub_uid (email_uid)`,
  )
  await ensureIndex(
    backend.table,
    `uq_${backend.key}_hub_dedupe`,
    `UNIQUE KEY uq_${backend.key}_hub_dedupe (dedupe_key)`,
  )

  await query(
    `CREATE TABLE IF NOT EXISTS \`${backend.automationTable}\` (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      event_key VARCHAR(60) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      template_id BIGINT UNSIGNED NULL,
      subject VARCHAR(255) NULL,
      cc TEXT NULL,
      updated_by BIGINT UNSIGNED NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_${backend.key}_autom_event (event_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  ensuredTables.add(backend.table)
}

// ---------------------------------------------------------------------------
// Create / send
// ---------------------------------------------------------------------------
export type CreateHubEmailInput = {
  toEmail?: string | null
  toName?: string | null
  recipientRef?: string | null
  vars?: Record<string, string>
  cc?: string | null
  bcc?: string | null
  subject: string
  body: string
  templateId?: number | null
  category?: string
  sourceModule?: string
  sourceRecordId?: string | null
  emailType?: "Manual" | "Automated"
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
  render?: boolean
}

export type CreateHubEmailResult =
  | { ok: true; id: number; emailUid: string; status: EmailHubStatus; deduped?: boolean }
  | { ok: false; error: string; code?: number }

export function buildDedupeKey(...parts: (string | number | null | undefined)[]): string {
  const basis = parts.map((p) => (p == null ? "" : String(p))).join("|")
  return crypto.createHash("sha1").update(basis).digest("hex")
}

function toMysqlDateTime(value: string | null | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 19).replace("T", " ")
}

async function generateEmailUid(backend: HubBackend): Promise<string> {
  const raw = await nextRecordId(backend.uidPrefix, { digits: 6 })
  const seq = raw.split("-")[1] ?? "000000"
  return `${backend.uidPrefix}-${new Date().getFullYear()}-${seq}`
}

export async function createHubEmail(
  backend: HubBackend,
  input: CreateHubEmailInput,
): Promise<CreateHubEmailResult> {
  await ensureHubSchema(backend)

  const category = (input.category || "General").trim() || "General"
  const sourceModule = (input.sourceModule || "manual").trim() || "manual"
  const emailType = input.emailType || "Manual"

  const toEmail = (input.toEmail || "").trim()
  const toName = input.toName ?? null
  const vars = input.vars || {}

  if (!isValidEmail(toEmail)) {
    return { ok: false, error: "A valid recipient email is required", code: 400 }
  }

  const cc = parseAddressList(input.cc)
  const bcc = parseAddressList(input.bcc)
  const badCc = [...cc, ...bcc].find((a) => !isValidEmail(a))
  if (badCc) return { ok: false, error: `Invalid CC/BCC address: ${badCc}`, code: 400 }

  let subject = (input.subject || "").trim()
  let bodyHtml = input.body || ""
  if (input.render !== false && Object.keys(vars).length > 0) {
    subject = renderTemplate(subject, vars)
    bodyHtml = renderTemplate(bodyHtml, vars)
  }
  if (!subject) return { ok: false, error: "Subject is required", code: 400 }
  if (!bodyHtml.trim()) return { ok: false, error: "Body is required", code: 400 }

  const scheduledAt = input.mode === "schedule" ? toMysqlDateTime(input.scheduledAt) : null
  if (input.mode === "schedule" && !scheduledAt) {
    return { ok: false, error: "A valid future date/time is required to schedule", code: 400 }
  }

  if (input.dedupeKey) {
    const existing = await query<any[]>(
      `SELECT id, email_uid, status FROM \`${backend.table}\`
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

  const initialStatus: EmailHubStatus =
    input.mode === "draft" ? "Draft" : input.mode === "schedule" ? "Scheduled" : "Sending"

  const trackingToken = generateTrackingToken()
  const emailUid = await generateEmailUid(backend)

  const result = await query<any>(
    `INSERT INTO \`${backend.table}\`
      (email_uid, recipient_ref, to_email, to_name, cc, bcc, template_id, subject, body,
       category, source_module, source_record_id, email_type, status, scheduled_at,
       thread_id, dedupe_key, attachment_pathname, attachment_name, attachment_type,
       attachment_size, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      emailUid,
      input.recipientRef || null,
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

  const sent = await sendHubEmailRow(backend, id)
  return { ok: true, id, emailUid, status: sent.status }
}

export async function sendHubEmailRow(
  backend: HubBackend,
  id: number,
): Promise<{ status: EmailHubStatus; error?: string }> {
  await ensureHubSchema(backend)

  const rows = await query<any[]>(`SELECT * FROM \`${backend.table}\` WHERE id = ? LIMIT 1`, [id])
  const row = rows[0]
  if (!row) return { status: "Failed", error: "Email not found" }
  if (row.status === "Sent") return { status: "Sent" }
  if (row.status === "Cancelled") return { status: "Cancelled" }

  if (!isEmailConfigured(backend.department)) {
    await query(`UPDATE \`${backend.table}\` SET status='Failed', last_error=? WHERE id=?`, [
      "Email transport is not configured",
      id,
    ])
    return { status: "Failed", error: "Email transport is not configured" }
  }

  await query(`UPDATE \`${backend.table}\` SET status='Sending' WHERE id=?`, [id])

  const baseUrl = (
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "")
  const token = row.thread_id || generateTrackingToken()
  const trackedBody = withTrackingPixel(row.body, baseUrl, token).replace(
    `/api/track/${token}`,
    `/api/${backend.key}/email-hub/track/${token}`,
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
      department: backend.department,
      senderUserId: row.created_by ? Number(row.created_by) : null,
      attachments: attachments.length ? attachments : undefined,
    })
    await query(
      `UPDATE \`${backend.table}\`
       SET status='Sent', message_id=?, thread_id=?, attempts=attempts+1,
           last_error=NULL, sent_at=NOW()
       WHERE id=?`,
      [res.messageId || null, token, id],
    )
    return { status: "Sent" }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send email"
    const attempts = Number(row.attempts || 0) + 1
    const requeue = row.status === "Scheduled" || row.status === "Queued" || row.scheduled_at
    const nextStatus: EmailHubStatus =
      attempts >= MAX_SEND_ATTEMPTS ? "Failed" : requeue ? "Queued" : "Failed"
    await query(
      `UPDATE \`${backend.table}\` SET status=?, attempts=?, last_error=?, thread_id=? WHERE id=?`,
      [nextStatus, attempts, message.slice(0, 500), token, id],
    )
    return { status: nextStatus, error: message }
  }
}

export async function dispatchDueHubEmails(
  backend: HubBackend,
  limit = 25,
): Promise<{ processed: number; sent: number; failed: number }> {
  await ensureHubSchema(backend)
  const due = await query<any[]>(
    `SELECT id FROM \`${backend.table}\`
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
    const res = await sendHubEmailRow(backend, Number(id))
    if (res.status === "Sent") sent++
    else if (res.status === "Failed") failed++
  }
  return { processed: due.length, sent, failed }
}

// ---------------------------------------------------------------------------
// Listing + summary
// ---------------------------------------------------------------------------
export type HubEmailListResult = {
  emails: any[]
  total: number
  page: number
  pageSize: number
  configured: boolean
  summary: {
    total: number
    sent: number
    failed: number
    pending: number
    drafts: number
    opened: number
  }
}

export async function listHubEmails(
  backend: HubBackend,
  opts: { q?: string; status?: string; category?: string; page?: number; pageSize?: number },
): Promise<HubEmailListResult> {
  await ensureHubSchema(backend)
  const page = Math.max(1, opts.page || 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize || 25))
  const where: string[] = []
  const args: any[] = []
  if (opts.q?.trim()) {
    const like = `%${opts.q.trim()}%`
    where.push("(email_uid LIKE ? OR to_email LIKE ? OR to_name LIKE ? OR subject LIKE ?)")
    args.push(like, like, like, like)
  }
  if (opts.status && opts.status !== "all") {
    where.push("status = ?")
    args.push(opts.status)
  }
  if (opts.category && opts.category !== "all") {
    where.push("category = ?")
    args.push(opts.category)
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const countRows = await query<any[]>(
    `SELECT COUNT(*) AS c FROM \`${backend.table}\` ${clause}`,
    args,
  )
  const total = Number(countRows[0]?.c || 0)

  const emails = await query<any[]>(
    `SELECT id, email_uid, recipient_ref, to_email, to_name, subject, category, status,
            email_type, open_count, scheduled_at, sent_at, created_at, updated_at
     FROM \`${backend.table}\` ${clause}
     ORDER BY COALESCE(scheduled_at, sent_at) DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...args, pageSize, (page - 1) * pageSize],
  )

  const summaryRows = await query<any[]>(
    `SELECT
       COUNT(*) AS total,
       SUM(status='Sent') AS sent,
       SUM(status='Failed') AS failed,
       SUM(status IN ('Scheduled','Queued','Sending')) AS pending,
       SUM(status='Draft') AS drafts,
       SUM(open_count > 0) AS opened
     FROM \`${backend.table}\``,
  )
  const s = summaryRows[0] || {}

  return {
    emails,
    total,
    page,
    pageSize,
    configured: isEmailConfigured(backend.department),
    summary: {
      total: Number(s.total || 0),
      sent: Number(s.sent || 0),
      failed: Number(s.failed || 0),
      pending: Number(s.pending || 0),
      drafts: Number(s.drafts || 0),
      opened: Number(s.opened || 0),
    },
  }
}

export async function getHubEmail(backend: HubBackend, id: number) {
  await ensureHubSchema(backend)
  const rows = await query<any[]>(`SELECT * FROM \`${backend.table}\` WHERE id = ? LIMIT 1`, [id])
  return rows[0] || null
}

export async function cancelHubEmail(backend: HubBackend, id: number): Promise<boolean> {
  await ensureHubSchema(backend)
  const res = await query<any>(
    `UPDATE \`${backend.table}\` SET status='Cancelled'
     WHERE id=? AND status IN ('Draft','Scheduled','Queued')`,
    [id],
  )
  return Number(res.affectedRows || 0) > 0
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------
export async function hubAnalytics(backend: HubBackend) {
  await ensureHubSchema(backend)
  const [totals] = await query<any[]>(
    `SELECT
       COUNT(*) AS total,
       SUM(status='Sent') AS sent,
       SUM(status='Failed') AS failed,
       SUM(status IN ('Scheduled','Queued','Sending')) AS pending,
       SUM(status='Draft') AS drafts,
       SUM(open_count > 0) AS opened,
       SUM(email_type='Automated') AS automated,
       SUM(email_type='Manual') AS manual
     FROM \`${backend.table}\``,
  )
  const byCategory = await query<any[]>(
    `SELECT category, COUNT(*) AS count FROM \`${backend.table}\`
     GROUP BY category ORDER BY count DESC LIMIT 12`,
  )
  const byStatus = await query<any[]>(
    `SELECT status, COUNT(*) AS count FROM \`${backend.table}\`
     GROUP BY status ORDER BY count DESC`,
  )
  const daily = await query<any[]>(
    `SELECT DATE(sent_at) AS day,
            SUM(status='Sent') AS sent,
            SUM(open_count > 0) AS opened
     FROM \`${backend.table}\`
     WHERE sent_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
     GROUP BY DATE(sent_at) ORDER BY day ASC`,
  )
  const t = totals || {}
  const sent = Number(t.sent || 0)
  const opened = Number(t.opened || 0)
  return {
    totals: {
      total: Number(t.total || 0),
      sent,
      failed: Number(t.failed || 0),
      pending: Number(t.pending || 0),
      drafts: Number(t.drafts || 0),
      opened,
      automated: Number(t.automated || 0),
      manual: Number(t.manual || 0),
    },
    openRate: sent > 0 ? Math.round((opened / sent) * 100) : 0,
    byCategory: byCategory.map((r) => ({ category: r.category, count: Number(r.count) })),
    byStatus: byStatus.map((r) => ({ status: r.status, count: Number(r.count) })),
    daily: daily.map((r) => ({
      day: r.day,
      sent: Number(r.sent || 0),
      opened: Number(r.opened || 0),
    })),
  }
}

// ---------------------------------------------------------------------------
// Automation config
// ---------------------------------------------------------------------------
export type HubAutomationConfig = HubAutomationEvent & {
  enabled: boolean
  template_id: number | null
  subject: string | null
  cc: string | null
}

export async function listHubAutomations(backend: HubBackend): Promise<HubAutomationConfig[]> {
  await ensureHubSchema(backend)
  const rows = await query<any[]>(
    `SELECT event_key, enabled, template_id, subject, cc FROM \`${backend.automationTable}\``,
  )
  const byKey = new Map(rows.map((r) => [r.event_key, r]))
  return backend.events.map((ev) => {
    const saved = byKey.get(ev.key)
    return {
      ...ev,
      enabled: saved ? Boolean(saved.enabled) : false,
      template_id: saved?.template_id != null ? Number(saved.template_id) : null,
      subject: saved?.subject ?? null,
      cc: saved?.cc ?? null,
    }
  })
}

export async function upsertHubAutomation(
  backend: HubBackend,
  eventKey: string,
  patch: { enabled?: boolean; template_id?: number | null; subject?: string | null; cc?: string | null },
  updatedBy: number | null,
): Promise<boolean> {
  await ensureHubSchema(backend)
  const event = backend.events.find((e) => e.key === eventKey)
  if (!event) return false
  await query(
    `INSERT INTO \`${backend.automationTable}\` (event_key, enabled, template_id, subject, cc, updated_by)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled),
       template_id = VALUES(template_id),
       subject = VALUES(subject),
       cc = VALUES(cc),
       updated_by = VALUES(updated_by)`,
    [
      eventKey,
      patch.enabled ? 1 : 0,
      patch.template_id ?? null,
      patch.subject ?? null,
      patch.cc ?? null,
      updatedBy,
    ],
  )
  return true
}
