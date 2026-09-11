import { query } from "@/lib/db"
import type { SessionPayload } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { nextRecordId } from "@/lib/record-ids"
import { getEmployeeById, getTimeZone, type EmployeeRecord } from "@/lib/hr-attendance"
import { addBusinessHours, toZonedDateTime, DEFAULT_BUSINESS_HOURS } from "@/lib/hr-support-business-hours"
import { isEmailConfigured, sendEmail } from "@/lib/email"

// ---------------------------------------------------------------------------
// HR Support — shared business logic for the employee helpdesk. This module is
// the single source of truth for the ticket lifecycle, SLA calculation,
// visibility scoping and cross-module linking so the API routes stay thin and
// never duplicate rules. It reuses existing ERP infrastructure everywhere:
// employees (hr_employees), users (assignment), the record-id sequencer,
// department email sender and the timezone/attendance helpers.
// ---------------------------------------------------------------------------

export const TICKET_STATUSES = ["Open", "In Progress", "Waiting", "Resolved", "Closed"] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export const PRIORITIES = ["Low", "Medium", "High", "Urgent"] as const
export type Priority = (typeof PRIORITIES)[number]

/** RBAC feature slugs — reuse the existing HR Support features + a sensitive gate. */
export const VIEW_FEATURE = "hr.view_support"
export const MANAGE_FEATURE = "hr.manage_support"
export const SENSITIVE_FEATURE = "hr.view_sensitive_support"

/**
 * Allowed status transitions. Agents drive these; reopening a Resolved/Closed
 * ticket sends it back to In Progress and bumps reopened_count.
 */
const TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  Open: ["In Progress", "Waiting", "Resolved", "Closed"],
  "In Progress": ["Waiting", "Resolved", "Closed", "Open"],
  Waiting: ["In Progress", "Resolved", "Closed", "Open"],
  Resolved: ["Closed", "In Progress", "Open"],
  Closed: ["In Progress", "Open"],
}

export function canTransition(from: string, to: string): boolean {
  if (!TICKET_STATUSES.includes(to as TicketStatus)) return false
  if (from === to) return true
  const allowed = TRANSITIONS[from as TicketStatus]
  return Boolean(allowed && allowed.includes(to as TicketStatus))
}

export function isReopen(from: string, to: string): boolean {
  return (from === "Resolved" || from === "Closed") && (to === "In Progress" || to === "Open")
}

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export type SupportCategory = {
  id: number
  name: string
  slug: string
  default_priority: Priority
  response_sla_hours: number
  resolution_sla_hours: number
  is_sensitive: number
  sort_order: number
  active: number
}

export type SlaState = "On Track" | "Due Soon" | "Breached" | "Met" | "N/A"

// Default categories seeded on first run. Response/resolution SLAs are in
// *business hours*. Sensitive categories (grievances) are hidden from agents
// without the sensitive-view feature.
const DEFAULT_CATEGORIES: Array<Omit<SupportCategory, "id">> = [
  { name: "Payroll", slug: "payroll", default_priority: "High", response_sla_hours: 4, resolution_sla_hours: 24, is_sensitive: 0, sort_order: 1, active: 1 },
  { name: "Attendance", slug: "attendance", default_priority: "Medium", response_sla_hours: 4, resolution_sla_hours: 16, is_sensitive: 0, sort_order: 2, active: 1 },
  { name: "Attendance Regularisation", slug: "regularisation", default_priority: "Medium", response_sla_hours: 4, resolution_sla_hours: 16, is_sensitive: 0, sort_order: 3, active: 1 },
  { name: "Leave", slug: "leave", default_priority: "Medium", response_sla_hours: 4, resolution_sla_hours: 16, is_sensitive: 0, sort_order: 4, active: 1 },
  { name: "Reimbursement", slug: "reimbursement", default_priority: "Medium", response_sla_hours: 8, resolution_sla_hours: 40, is_sensitive: 0, sort_order: 5, active: 1 },
  { name: "Documents", slug: "documents", default_priority: "Low", response_sla_hours: 8, resolution_sla_hours: 40, is_sensitive: 0, sort_order: 6, active: 1 },
  { name: "IT / Systems", slug: "it-systems", default_priority: "High", response_sla_hours: 2, resolution_sla_hours: 8, is_sensitive: 0, sort_order: 7, active: 1 },
  { name: "Facilities", slug: "facilities", default_priority: "Low", response_sla_hours: 8, resolution_sla_hours: 40, is_sensitive: 0, sort_order: 8, active: 1 },
  { name: "Onboarding", slug: "onboarding", default_priority: "Medium", response_sla_hours: 8, resolution_sla_hours: 24, is_sensitive: 0, sort_order: 9, active: 1 },
  { name: "Offboarding", slug: "offboarding", default_priority: "Medium", response_sla_hours: 8, resolution_sla_hours: 24, is_sensitive: 0, sort_order: 10, active: 1 },
  { name: "Policy", slug: "policy", default_priority: "Low", response_sla_hours: 8, resolution_sla_hours: 40, is_sensitive: 0, sort_order: 11, active: 1 },
  { name: "Grievance", slug: "grievance", default_priority: "High", response_sla_hours: 4, resolution_sla_hours: 24, is_sensitive: 1, sort_order: 12, active: 1 },
  { name: "Other", slug: "other", default_priority: "Medium", response_sla_hours: 8, resolution_sla_hours: 40, is_sensitive: 0, sort_order: 99, active: 1 },
]

// ---------------------------------------------------------------------------
// Schema — additive & idempotent, self-healing at runtime so a missed migration
// never breaks the feature. Every new column is nullable/defaulted so the
// original clock-in/POST paths and historical rows keep working unchanged.
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null
export function ensureSupportSchema(): Promise<void> {
  if (!ensured) ensured = doEnsure()
  return ensured
}

async function addColumn(definition: string) {
  try {
    await query(`ALTER TABLE hr_support_tickets ADD COLUMN ${definition}`)
  } catch {
    // Column already exists (MySQL 8 lacks ADD COLUMN IF NOT EXISTS).
  }
}

async function doEnsure() {
  // Base table (matches the migration) so a fresh DB without the migration still works.
  await query(`
    CREATE TABLE IF NOT EXISTS hr_support_tickets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      ticket_id VARCHAR(40) NOT NULL UNIQUE,
      employee_id BIGINT UNSIGNED NULL,
      employee_name VARCHAR(150) NULL,
      support_category VARCHAR(80) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      priority ENUM('Low','Medium','High','Urgent') NOT NULL DEFAULT 'Medium',
      attachment_path VARCHAR(500) NULL,
      status ENUM('Open','In Progress','Waiting','Resolved','Closed') NOT NULL DEFAULT 'Open',
      assigned_to BIGINT UNSIGNED NULL,
      assigned_to_name VARCHAR(150) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      first_response_at DATETIME NULL,
      resolved_at DATETIME NULL,
      resolution TEXT NULL,
      employee_remarks TEXT NULL,
      hr_remarks TEXT NULL,
      sla_due_date DATETIME NULL,
      closed_by VARCHAR(150) NULL,
      closed_at DATETIME NULL,
      INDEX idx_hr_support_status (status),
      INDEX idx_hr_support_employee (employee_id),
      INDEX idx_hr_support_priority (priority),
      INDEX idx_hr_support_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Additive columns for the full helpdesk.
  const columns = [
    "created_by_user_id BIGINT UNSIGNED NULL",
    "created_by_name VARCHAR(150) NULL",
    "department VARCHAR(150) NULL",
    "designation VARCHAR(150) NULL",
    "manager_name VARCHAR(150) NULL",
    "subcategory VARCHAR(120) NULL",
    "issue_type VARCHAR(120) NULL",
    "source VARCHAR(30) NOT NULL DEFAULT 'Web'",
    "is_sensitive TINYINT(1) NOT NULL DEFAULT 0",
    "first_response_due DATETIME NULL",
    "sla_response_breached TINYINT(1) NOT NULL DEFAULT 0",
    "sla_resolution_breached TINYINT(1) NOT NULL DEFAULT 0",
    "reopened_count INT NOT NULL DEFAULT 0",
    "csat_rating TINYINT NULL",
    "csat_comment TEXT NULL",
    "related_attendance_id BIGINT UNSIGNED NULL",
    "related_regularisation_id BIGINT UNSIGNED NULL",
    "related_leave_id BIGINT UNSIGNED NULL",
    "related_document_id BIGINT UNSIGNED NULL",
    "related_payroll_id BIGINT UNSIGNED NULL",
    "related_offboarding_id BIGINT UNSIGNED NULL",
    "updated_at DATETIME NULL",
  ]
  for (const def of columns) await addColumn(def)

  // Widen status/priority to VARCHAR-safe? Keep ENUMs; they already cover us.

  // Conversation, notes and attachments.
  await query(`
    CREATE TABLE IF NOT EXISTS hr_support_messages (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      ticket_id BIGINT UNSIGNED NOT NULL,
      author_user_id BIGINT UNSIGNED NULL,
      author_name VARCHAR(150) NULL,
      author_role VARCHAR(20) NULL,
      body TEXT NOT NULL,
      is_internal TINYINT(1) NOT NULL DEFAULT 0,
      attachment_path VARCHAR(500) NULL,
      attachment_name VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_support_msg_ticket (ticket_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS hr_support_attachments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      ticket_id BIGINT UNSIGNED NOT NULL,
      message_id BIGINT UNSIGNED NULL,
      file_name VARCHAR(255) NULL,
      file_url VARCHAR(500) NOT NULL,
      file_size BIGINT UNSIGNED NULL,
      uploaded_by BIGINT UNSIGNED NULL,
      uploaded_by_name VARCHAR(150) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_support_att_ticket (ticket_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Activity timeline (status changes, assignment, SLA breaches, etc.).
  await query(`
    CREATE TABLE IF NOT EXISTS hr_support_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      ticket_id BIGINT UNSIGNED NOT NULL,
      actor_user_id BIGINT UNSIGNED NULL,
      actor_name VARCHAR(150) NULL,
      event_type VARCHAR(60) NOT NULL,
      detail VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_support_event_ticket (ticket_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Category master.
  await query(`
    CREATE TABLE IF NOT EXISTS hr_support_categories (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      slug VARCHAR(120) NOT NULL UNIQUE,
      default_priority ENUM('Low','Medium','High','Urgent') NOT NULL DEFAULT 'Medium',
      response_sla_hours INT NOT NULL DEFAULT 8,
      resolution_sla_hours INT NOT NULL DEFAULT 40,
      is_sensitive TINYINT(1) NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      active TINYINT(1) NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Optional lightweight knowledge base (future-ready; suggested to agents).
  await query(`
    CREATE TABLE IF NOT EXISTS hr_support_kb (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      slug VARCHAR(200) NOT NULL UNIQUE,
      category_slug VARCHAR(120) NULL,
      body TEXT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Seed categories if empty.
  const count = await query<{ c: number }[]>("SELECT COUNT(*) AS c FROM hr_support_categories")
  if (Number(count[0]?.c || 0) === 0) {
    for (const c of DEFAULT_CATEGORIES) {
      await query(
        `INSERT IGNORE INTO hr_support_categories
           (name, slug, default_priority, response_sla_hours, resolution_sla_hours, is_sensitive, sort_order, active)
         VALUES (?,?,?,?,?,?,?,?)`,
        [c.name, c.slug, c.default_priority, c.response_sla_hours, c.resolution_sla_hours, c.is_sensitive, c.sort_order, c.active],
      )
    }
  }

  // Register RBAC feature for sensitive tickets (view/manage already seeded by migration).
  try {
    await query(
      `INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
       SELECT id, 'View Sensitive HR Tickets', ?, 'Access grievances and other sensitive HR support cases', 7
       FROM modules WHERE slug = 'hr'`,
      [SENSITIVE_FEATURE],
    )
  } catch {
    // features table shape differs / already present — non-fatal.
  }
}

// ---------------------------------------------------------------------------
// Access + identity helpers.
// ---------------------------------------------------------------------------

/** True when the session may see/manage every ticket (HR/Admin agents). */
export async function canManageSupport(session: SessionPayload): Promise<boolean> {
  return userHasFeature(session.userId, session.role, MANAGE_FEATURE)
}

/** True when the session may view sensitive (grievance) tickets. */
export async function canViewSensitive(session: SessionPayload): Promise<boolean> {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, SENSITIVE_FEATURE)
}

/** The employee record linked to the session by email, or null if unmapped. */
export async function resolveSessionEmployee(session: SessionPayload): Promise<EmployeeRecord | null> {
  const rows = await query<{ id: number }[]>(
    "SELECT id FROM hr_employees WHERE official_email = ? OR personal_email = ? LIMIT 1",
    [session.email, session.email],
  )
  if (!rows[0]) return null
  return getEmployeeById(Number(rows[0].id))
}

// ---------------------------------------------------------------------------
// Categories.
// ---------------------------------------------------------------------------

export async function getCategories(includeInactive = false): Promise<SupportCategory[]> {
  const rows = await query<SupportCategory[]>(
    `SELECT * FROM hr_support_categories ${includeInactive ? "" : "WHERE active = 1"} ORDER BY sort_order ASC, name ASC`,
  )
  return rows
}

export async function getCategoryBySlugOrName(value: string): Promise<SupportCategory | null> {
  const rows = await query<SupportCategory[]>(
    "SELECT * FROM hr_support_categories WHERE slug = ? OR name = ? LIMIT 1",
    [value, value],
  )
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// SLA.
// ---------------------------------------------------------------------------

export type SlaResult = {
  firstResponseDue: string // company-tz DATETIME
  resolutionDue: string // company-tz DATETIME
}

/** Compute response + resolution due dates from category SLA and priority. */
export async function computeSla(
  category: SupportCategory | null,
  priority: Priority,
  from: Date = new Date(),
): Promise<SlaResult> {
  const tz = await getTimeZone()
  // Priority multiplier tightens the SLA for urgent cases.
  const multiplier = priority === "Urgent" ? 0.5 : priority === "High" ? 0.75 : priority === "Low" ? 1.5 : 1
  const responseHours = Math.max(1, Math.round((category?.response_sla_hours ?? 8) * multiplier))
  const resolutionHours = Math.max(2, Math.round((category?.resolution_sla_hours ?? 40) * multiplier))
  const firstResponseDue = toZonedDateTime(addBusinessHours(from, responseHours, tz, DEFAULT_BUSINESS_HOURS), tz)
  const resolutionDue = toZonedDateTime(addBusinessHours(from, resolutionHours, tz, DEFAULT_BUSINESS_HOURS), tz)
  return { firstResponseDue, resolutionDue }
}

/** Now as a company-tz DATETIME string, for comparisons/writes. */
export async function nowZoned(): Promise<string> {
  const tz = await getTimeZone()
  return toZonedDateTime(new Date(), tz)
}

/**
 * Derive a display SLA state from stored due dates. Lexicographic comparison is
 * valid because both sides are `YYYY-MM-DD HH:MM:SS` in the same timezone.
 */
export function resolutionSlaState(ticket: {
  status: string
  sla_due_date: string | null
  resolved_at: string | null
  sla_resolution_breached?: number
}, now: string): SlaState {
  if (!ticket.sla_due_date) return "N/A"
  if (ticket.status === "Resolved" || ticket.status === "Closed") {
    if (ticket.resolved_at) return ticket.resolved_at <= ticket.sla_due_date ? "Met" : "Breached"
    return "Met"
  }
  if (now > ticket.sla_due_date) return "Breached"
  // "Due soon" when within 25% of the window remaining is approximated by a
  // fixed 4h look-ahead in wall-clock terms.
  const soon = addHoursToDateTimeString(now, 4)
  if (soon >= ticket.sla_due_date) return "Due Soon"
  return "On Track"
}

/** Add whole hours to a `YYYY-MM-DD HH:MM:SS` string (calendar, for look-ahead). */
function addHoursToDateTimeString(value: string, hours: number): string {
  const iso = value.replace(" ", "T")
  const d = new Date(iso + "Z")
  d.setUTCHours(d.getUTCHours() + hours)
  return d.toISOString().slice(0, 19).replace("T", " ")
}

// ---------------------------------------------------------------------------
// Events / timeline + messages.
// ---------------------------------------------------------------------------

export async function logSupportEvent(opts: {
  ticketId: number
  actorId?: number | null
  actorName?: string | null
  type: string
  detail?: string | null
}): Promise<void> {
  try {
    await query(
      "INSERT INTO hr_support_events (ticket_id, actor_user_id, actor_name, event_type, detail) VALUES (?,?,?,?,?)",
      [opts.ticketId, opts.actorId ?? null, opts.actorName ?? null, opts.type, opts.detail ?? null],
    )
  } catch (error) {
    console.error("[v0] logSupportEvent failed:", (error as Error).message)
  }
}

export async function addSupportMessage(opts: {
  ticketId: number
  authorId?: number | null
  authorName?: string | null
  authorRole?: string | null
  body: string
  isInternal?: boolean
  attachmentPath?: string | null
  attachmentName?: string | null
}): Promise<void> {
  await query(
    `INSERT INTO hr_support_messages
       (ticket_id, author_user_id, author_name, author_role, body, is_internal, attachment_path, attachment_name)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      opts.ticketId,
      opts.authorId ?? null,
      opts.authorName ?? null,
      opts.authorRole ?? null,
      opts.body,
      opts.isInternal ? 1 : 0,
      opts.attachmentPath ?? null,
      opts.attachmentName ?? null,
    ],
  )
}

// ---------------------------------------------------------------------------
// Ticket ID.
// ---------------------------------------------------------------------------

export async function nextTicketId(): Promise<string> {
  return nextRecordId("HRS", { allowCustom: true, digits: 5 })
}

// ---------------------------------------------------------------------------
// Notifications — reuse the department email sender. Never throws.
// ---------------------------------------------------------------------------

export async function notifyTicketEmail(opts: {
  to: string | null | undefined
  subject: string
  html: string
}): Promise<void> {
  if (!opts.to) return
  if (!isEmailConfigured("hr")) return
  try {
    await sendEmail({ to: opts.to, subject: opts.subject, html: opts.html, department: "hr" })
  } catch (error) {
    console.error("[v0] notifyTicketEmail failed:", (error as Error).message)
  }
}

/** Email of the employee linked to a ticket (for status notifications). */
export async function getEmployeeEmail(employeeId: number | null | undefined): Promise<string | null> {
  if (!employeeId) return null
  const rows = await query<{ official_email: string | null; personal_email: string | null }[]>(
    "SELECT official_email, personal_email FROM hr_employees WHERE id = ? LIMIT 1",
    [employeeId],
  )
  return rows[0]?.official_email || rows[0]?.personal_email || null
}

/** Email of a user account (for assignee/agent notifications). */
export async function getUserEmail(userId: number | null | undefined): Promise<string | null> {
  if (!userId) return null
  const rows = await query<{ email: string | null }[]>("SELECT email FROM users WHERE id = ? LIMIT 1", [userId])
  return rows[0]?.email || null
}

// ---------------------------------------------------------------------------
// Related ERP records — Section 18. We never copy the source rows into the
// ticket; we store only the foreign keys and resolve a light summary on demand
// so authorised users can jump to the originating module. Every lookup is
// best-effort: a missing table or row simply yields no card.
// ---------------------------------------------------------------------------

export type RelatedRecord = {
  kind: string
  label: string
  reference: string
  sublabel: string | null
  status: string | null
  href: string | null
}

async function safe<T>(sql: string, params: unknown[]): Promise<T[]> {
  try {
    return await query<T[]>(sql, params)
  } catch {
    return []
  }
}

/** Resolve display summaries for whichever related_* ids a ticket carries. */
export async function getRelatedRecords(ticket: Record<string, any>): Promise<RelatedRecord[]> {
  const out: RelatedRecord[] = []

  if (ticket.related_attendance_id) {
    const r = (await safe<any>("SELECT id, attendance_id, work_date, status, working_hours FROM hr_attendance WHERE id = ? LIMIT 1", [ticket.related_attendance_id]))[0]
    if (r) out.push({ kind: "Attendance", label: "Attendance", reference: r.attendance_id || `#${r.id}`, sublabel: r.work_date ? String(r.work_date).slice(0, 10) : null, status: r.status ?? null, href: "/modules/hr/attendance" })
  }
  if (ticket.related_regularisation_id) {
    const r = (await safe<any>("SELECT id, request_id, work_date, status FROM hr_attendance_regularisation WHERE id = ? LIMIT 1", [ticket.related_regularisation_id]))[0]
    if (r) out.push({ kind: "Regularisation", label: "Attendance Regularisation", reference: r.request_id || `#${r.id}`, sublabel: r.work_date ? String(r.work_date).slice(0, 10) : null, status: r.status ?? null, href: "/modules/hr/attendance-regularisation" })
  }
  if (ticket.related_leave_id) {
    const r = (await safe<any>(
      `SELECT lr.id, lr.request_id, lr.from_date, lr.to_date, lr.status, lt.leave_type AS leave_type_name
       FROM hr_leave_requests lr LEFT JOIN hr_leave_types lt ON lt.leave_type_id = lr.leave_type_id
       WHERE lr.id = ? LIMIT 1`,
      [ticket.related_leave_id],
    ))[0]
    if (r) out.push({ kind: "Leave", label: r.leave_type_name || "Leave request", reference: r.request_id || `#${r.id}`, sublabel: r.from_date ? `${String(r.from_date).slice(0, 10)} → ${String(r.to_date).slice(0, 10)}` : null, status: r.status ?? null, href: "/modules/hr/leave-requests" })
  }
  if (ticket.related_document_id) {
    const r = (await safe<any>("SELECT id, document_ref, document_type, status, expiry_date FROM hr_employee_documents WHERE id = ? LIMIT 1", [ticket.related_document_id]))[0]
    if (r) out.push({ kind: "Document", label: r.document_type || "Employee document", reference: r.document_ref || `#${r.id}`, sublabel: r.expiry_date ? `Expires ${String(r.expiry_date).slice(0, 10)}` : null, status: r.status ?? null, href: "/modules/hr/employee-documents" })
  }
  if (ticket.related_offboarding_id) {
    const r = (await safe<any>("SELECT id, offboarding_id, exit_type, status, last_working_date FROM hr_offboarding WHERE id = ? LIMIT 1", [ticket.related_offboarding_id]))[0]
    if (r) out.push({ kind: "Offboarding", label: r.exit_type ? `${r.exit_type} exit` : "Offboarding", reference: r.offboarding_id || `#${r.id}`, sublabel: r.last_working_date ? `LWD ${String(r.last_working_date).slice(0, 10)}` : null, status: r.status ?? null, href: "/modules/hr/offboarding" })
  }
  if (ticket.related_payroll_id) {
    out.push({ kind: "Payroll", label: "Payroll record", reference: `#${ticket.related_payroll_id}`, sublabel: null, status: null, href: null })
  }

  return out
}
