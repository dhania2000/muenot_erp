import { query } from "./db"
import type { SessionPayload } from "./auth"
import { userHasFeature } from "./permissions"
import { isEmailConfigured, sendEmail } from "./email"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const PRIORITIES = ["normal", "important", "urgent"] as const
export type Priority = (typeof PRIORITIES)[number]

export const STATUSES = ["draft", "scheduled", "published", "expired", "archived", "cancelled"] as const
export type Status = (typeof STATUSES)[number]

export const AUDIENCE_TYPES = ["all", "department", "designation", "location", "employment_type", "employees"] as const
export type AudienceType = (typeof AUDIENCE_TYPES)[number]

export const DEFAULT_CATEGORIES = [
  "General", "HR", "Finance", "IT", "Operations", "Sales", "Recruitment",
  "Policy", "Compliance", "Holiday", "Emergency", "Training", "Event", "Other",
]

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024 // 20 MB
export const ATTACHMENT_ALLOWED_EXT = [
  "pdf", "doc", "docx", "xls", "xlsx", "csv", "ppt", "pptx",
  "png", "jpg", "jpeg", "gif", "webp",
]

export type AudienceConfig = {
  departments?: string[]
  designations?: string[]
  locations?: string[]
  employmentTypes?: string[]
  employeeIds?: number[]
}

// ---------------------------------------------------------------------------
// Schema self-healing (mirrors database/migrations/2026-10-11-upgrade-notice-board.sql)
// ---------------------------------------------------------------------------
let schemaReady = false

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<{ c: number }[]>(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  )
  return (rows[0]?.c ?? 0) > 0
}

async function addColumn(table: string, column: string, definition: string) {
  if (!(await columnExists(table, column))) {
    await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).catch((e) => {
      console.error(`[notice-board] add column ${table}.${column} failed`, e?.message)
    })
    return true
  }
  return false
}

export async function ensureNoticeSchema() {
  if (schemaReady) return

  // The base `notices` table already exists (created by the original migration).
  // Add the lifecycle columns defensively so older installs self-heal.
  const additions: Array<[string, string]> = [
    ["notice_code", "VARCHAR(30) NULL"],
    ["category", "VARCHAR(80) NOT NULL DEFAULT 'General'"],
    ["priority", "ENUM('normal','important','urgent') NOT NULL DEFAULT 'normal'"],
    ["status", "ENUM('draft','scheduled','published','expired','archived','cancelled') NOT NULL DEFAULT 'draft'"],
    ["audience_type", "ENUM('all','department','designation','location','employment_type','employees') NOT NULL DEFAULT 'all'"],
    ["audience_config", "JSON NULL"],
    ["include_inactive", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["start_date", "DATE NULL"],
    ["end_date", "DATE NULL"],
    ["publish_date", "DATETIME NULL"],
    ["published_at", "DATETIME NULL"],
    ["expired_at", "DATETIME NULL"],
    ["acknowledgement_required", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["notify_in_app", "TINYINT(1) NOT NULL DEFAULT 1"],
    ["notify_email", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["pinned", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["keep_pinned_after_expiry", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["cancel_reason", "VARCHAR(500) NULL"],
    ["effective_date", "DATE NULL"],
    ["review_date", "DATE NULL"],
    ["version", "INT NOT NULL DEFAULT 1"],
    ["recipients_finalized", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["updated_by", "INT NULL"],
    ["updated_by_name", "VARCHAR(150) NULL"],
  ]

  const statusJustAdded = !(await columnExists("notices", "status"))
  for (const [col, def] of additions) await addColumn("notices", col, def)

  if (statusJustAdded) {
    // Existing rows were live announcements — preserve their visibility.
    await query(
      `UPDATE notices SET status = 'published',
         published_at = COALESCE(published_at, created_at),
         publish_date = COALESCE(publish_date, created_at)`,
    ).catch(() => {})
    await query(
      `UPDATE notices SET audience_type = 'department'
       WHERE department IS NOT NULL AND department <> ''`,
    ).catch(() => {})
  }
  // Backfill notice codes for any row missing one.
  await query(
    `UPDATE notices SET notice_code = CONCAT('NOT-', YEAR(created_at), '-', LPAD(id, 6, '0'))
     WHERE notice_code IS NULL OR notice_code = ''`,
  ).catch(() => {})

  // Indexes (ignore "duplicate key name").
  const indexes = [
    "CREATE UNIQUE INDEX uniq_notice_code ON notices (notice_code)",
    "CREATE INDEX idx_notices_status ON notices (status)",
    "CREATE INDEX idx_notices_category ON notices (category)",
    "CREATE INDEX idx_notices_priority ON notices (priority)",
    "CREATE INDEX idx_notices_publish_date ON notices (publish_date)",
    "CREATE INDEX idx_notices_end_date ON notices (end_date)",
  ]
  for (const sql of indexes) await query(sql).catch(() => {})

  await query(`CREATE TABLE IF NOT EXISTS notice_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    sort_order INT NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_notice_category (name)
  )`)
  for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
    await query("INSERT IGNORE INTO notice_categories (name, sort_order) VALUES (?, ?)", [DEFAULT_CATEGORIES[i], i + 1])
  }

  await query(`CREATE TABLE IF NOT EXISTS notice_recipients (
    id INT AUTO_INCREMENT PRIMARY KEY,
    notice_id INT NOT NULL,
    employee_id INT UNSIGNED NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_notice_recipient (notice_id, employee_id),
    KEY idx_nr_employee (employee_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS notice_reads (
    id INT AUTO_INCREMENT PRIMARY KEY,
    notice_id INT NOT NULL,
    employee_id INT UNSIGNED NOT NULL,
    read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_notice_read (notice_id, employee_id),
    KEY idx_nrd_employee (employee_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS notice_acknowledgements (
    id INT AUTO_INCREMENT PRIMARY KEY,
    notice_id INT NOT NULL,
    employee_id INT UNSIGNED NOT NULL,
    acknowledged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_notice_ack (notice_id, employee_id),
    KEY idx_nack_employee (employee_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS notice_attachments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    notice_id INT NULL,
    draft_key VARCHAR(64) NULL,
    file_name VARCHAR(255) NOT NULL,
    file_type VARCHAR(150) NULL,
    file_size INT NOT NULL DEFAULT 0,
    storage_url VARCHAR(1024) NOT NULL,
    uploaded_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_na_notice (notice_id),
    KEY idx_na_draft (draft_key)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS notice_audit (
    id INT AUTO_INCREMENT PRIMARY KEY,
    notice_id INT NULL,
    user_id INT NULL,
    user_name VARCHAR(150) NULL,
    action VARCHAR(60) NOT NULL,
    detail VARCHAR(1000) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_naudit_notice (notice_id),
    KEY idx_naudit_action (action)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS notice_versions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    notice_id INT NOT NULL,
    version INT NOT NULL,
    heading VARCHAR(200) NOT NULL,
    description MEDIUMTEXT NOT NULL,
    category VARCHAR(80) NULL,
    priority VARCHAR(20) NULL,
    edited_by INT NULL,
    edited_by_name VARCHAR(150) NULL,
    edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_nv_notice (notice_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS notice_deliveries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    notice_id INT NOT NULL,
    employee_id INT UNSIGNED NOT NULL,
    channel ENUM('in_app','email') NOT NULL,
    status ENUM('created','sent','failed') NOT NULL DEFAULT 'created',
    error VARCHAR(500) NULL,
    attempts INT NOT NULL DEFAULT 0,
    sent_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_notice_delivery (notice_id, employee_id, channel),
    KEY idx_nd_status (status)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS notice_reminders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    notice_id INT NOT NULL,
    employee_id INT UNSIGNED NOT NULL,
    reminder_no INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_notice_reminder (notice_id, employee_id, reminder_no)
  )`)

  schemaReady = true
}

// ---------------------------------------------------------------------------
// RBAC helpers
// ---------------------------------------------------------------------------
export async function canView(session: SessionPayload) {
  return userHasFeature(session.userId, session.role, "notice-board.view")
}
export async function canManage(session: SessionPayload) {
  return session.role === "admin" || userHasFeature(session.userId, session.role, "notice-board.manage")
}

// ---------------------------------------------------------------------------
// Employee identity resolution (links a login user to an HR employee record)
// ---------------------------------------------------------------------------
export type EmployeeIdentity = {
  id: number
  employee_name: string
  department: string | null
  designation: string | null
  work_location: string | null
  employment_type: string | null
  employment_status: string | null
  email: string | null
}

export async function resolveEmployee(session: SessionPayload): Promise<EmployeeIdentity | null> {
  const rows = await query<EmployeeIdentity[]>(
    `SELECT id, employee_name, department, designation, work_location, employment_type, employment_status,
            COALESCE(official_email, personal_email) AS email
       FROM hr_employees
      WHERE user_id = ? OR official_email = ? OR personal_email = ?
      ORDER BY (user_id = ?) DESC
      LIMIT 1`,
    [session.userId, session.email, session.email, session.userId],
  )
  return rows[0] ?? null
}

function isActive(status: string | null | undefined) {
  return String(status ?? "").trim().toLowerCase() === "active"
}

// ---------------------------------------------------------------------------
// Audience resolution
// ---------------------------------------------------------------------------
export function parseAudienceConfig(raw: unknown): AudienceConfig {
  if (!raw) return {}
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as AudienceConfig } catch { return {} }
  }
  return raw as AudienceConfig
}

/** Resolve the set of ACTIVE (unless include_inactive) employees for a notice's audience. */
export async function resolveAudienceEmployees(notice: any): Promise<EmployeeIdentity[]> {
  const cfg = parseAudienceConfig(notice.audience_config)
  const where: string[] = ["1=1"]
  const params: any[] = []

  switch (notice.audience_type as AudienceType) {
    case "department":
      if (cfg.departments?.length) { where.push(`department IN (${cfg.departments.map(() => "?").join(",")})`); params.push(...cfg.departments) }
      else return []
      break
    case "designation":
      if (cfg.designations?.length) { where.push(`designation IN (${cfg.designations.map(() => "?").join(",")})`); params.push(...cfg.designations) }
      else return []
      break
    case "location":
      if (cfg.locations?.length) { where.push(`work_location IN (${cfg.locations.map(() => "?").join(",")})`); params.push(...cfg.locations) }
      else return []
      break
    case "employment_type":
      if (cfg.employmentTypes?.length) { where.push(`employment_type IN (${cfg.employmentTypes.map(() => "?").join(",")})`); params.push(...cfg.employmentTypes) }
      else return []
      break
    case "employees":
      if (cfg.employeeIds?.length) { where.push(`id IN (${cfg.employeeIds.map(() => "?").join(",")})`); params.push(...cfg.employeeIds) }
      else return []
      break
    case "all":
    default:
      break
  }

  const rows = await query<EmployeeIdentity[]>(
    `SELECT id, employee_name, department, designation, work_location, employment_type, employment_status,
            COALESCE(official_email, personal_email) AS email
       FROM hr_employees WHERE ${where.join(" AND ")}`,
    params,
  )
  return notice.include_inactive ? rows : rows.filter((r) => isActive(r.employment_status))
}

/** Validate that a targeted audience has at least one selection. Returns an error string or null. */
export function normalizeAudienceValidated(toType: string, type: AudienceType, cfg: AudienceConfig): string | null {
  if (toType === "clients") return null
  if (type === "all") return null
  const map: Record<string, keyof AudienceConfig> = {
    department: "departments", designation: "designations", location: "locations",
    employment_type: "employmentTypes", employees: "employeeIds",
  }
  const key = map[type]
  const arr = key ? (cfg as any)[key] : null
  if (!Array.isArray(arr) || arr.length === 0)
    return "Please select at least one target for the chosen audience type"
  return null
}

/** Count valid recipients without materializing — used by the create form. */
export async function previewAudienceCount(payload: {
  audience_type: AudienceType
  audience_config: AudienceConfig
  include_inactive: boolean
}): Promise<number> {
  const emps = await resolveAudienceEmployees({
    audience_type: payload.audience_type,
    audience_config: payload.audience_config,
    include_inactive: payload.include_inactive,
  })
  return emps.length
}

/** Count + small sample of recipients, for the compose form preview. */
export async function previewAudience(
  audienceType: AudienceType,
  audienceConfig: AudienceConfig,
  includeInactive: boolean,
): Promise<{ count: number; sample: { id: number; name: string; department: string | null }[] }> {
  const emps = await resolveAudienceEmployees({
    audience_type: audienceType,
    audience_config: audienceConfig,
    include_inactive: includeInactive,
  })
  return {
    count: emps.length,
    sample: emps.slice(0, 8).map((e) => ({ id: e.id, name: e.employee_name, department: e.department })),
  }
}

/** Materialize the recipient list (idempotent — INSERT IGNORE). */
export async function materializeRecipients(noticeId: number, notice: any): Promise<number> {
  if (notice.to_type === "clients") {
    await query("UPDATE notices SET recipients_finalized = 1 WHERE id = ?", [noticeId])
    return 0
  }
  const emps = await resolveAudienceEmployees(notice)
  for (const e of emps) {
    await query("INSERT IGNORE INTO notice_recipients (notice_id, employee_id) VALUES (?, ?)", [noticeId, e.id])
  }
  await query("UPDATE notices SET recipients_finalized = 1 WHERE id = ?", [noticeId])
  return emps.length
}

// ---------------------------------------------------------------------------
// Audit + versioning
// ---------------------------------------------------------------------------
export async function audit(noticeId: number | null, session: SessionPayload | null, action: string, detail?: string) {
  await query(
    "INSERT INTO notice_audit (notice_id, user_id, user_name, action, detail) VALUES (?, ?, ?, ?, ?)",
    [noticeId, session?.userId ?? null, session?.name ?? null, action, detail?.slice(0, 1000) ?? null],
  ).catch((e) => console.error("[notice-board] audit failed", e?.message))
}

export async function snapshotVersion(notice: any, session: SessionPayload | null) {
  await query(
    `INSERT INTO notice_versions (notice_id, version, heading, description, category, priority, edited_by, edited_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [notice.id, notice.version ?? 1, notice.heading, notice.description, notice.category, notice.priority,
      session?.userId ?? null, session?.name ?? null],
  ).catch((e) => console.error("[notice-board] version snapshot failed", e?.message))
}

// ---------------------------------------------------------------------------
// Notice code
// ---------------------------------------------------------------------------
export async function assignNoticeCode(noticeId: number) {
  await query(
    `UPDATE notices SET notice_code = CONCAT('NOT-', YEAR(created_at), '-', LPAD(id, 6, '0'))
     WHERE id = ? AND (notice_code IS NULL OR notice_code = '')`,
    [noticeId],
  )
}

// ---------------------------------------------------------------------------
// Publishing status derivation
// ---------------------------------------------------------------------------
/** Given form data, decide the initial status when a manager clicks Publish. */
export function statusForPublish(publishDate: string | null, endDate: string | null): Status {
  const now = Date.now()
  if (publishDate) {
    const p = new Date(publishDate.replace(" ", "T")).getTime()
    if (!Number.isNaN(p) && p > now) return "scheduled"
  }
  if (endDate) {
    const e = new Date(`${endDate}T23:59:59`).getTime()
    if (!Number.isNaN(e) && e < now) return "expired"
  }
  return "published"
}

// ---------------------------------------------------------------------------
// Notifications + Email dispatch (idempotent)
// ---------------------------------------------------------------------------
function noticeLink(baseUrl: string | null) {
  const base = baseUrl || process.env.NEXT_PUBLIC_APP_URL || ""
  return `${base}/modules/notice-board`
}

function buildEmailHtml(vars: Record<string, string>) {
  const priorityColor = vars.priority === "urgent" ? "#dc2626" : vars.priority === "important" ? "#d97706" : "#2563eb"
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111827">
    <div style="border-left:4px solid ${priorityColor};padding:8px 16px;margin-bottom:16px">
      <span style="display:inline-block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:${priorityColor};font-weight:700">${vars.priority} • ${vars.category}</span>
      <h2 style="margin:6px 0 0;font-size:18px">${vars.title}</h2>
    </div>
    <p style="margin:0 0 12px">Hi ${vars.employee_name || "there"},</p>
    <p style="margin:0 0 12px">A new notice has been published on the company notice board.</p>
    <table style="font-size:13px;color:#374151;margin:0 0 16px">
      <tr><td style="padding:2px 12px 2px 0;color:#6b7280">Published</td><td>${vars.publish_date || "-"}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#6b7280">Expires</td><td>${vars.expiry_date || "-"}</td></tr>
    </table>
    <a href="${vars.notice_link}" style="display:inline-block;background:${priorityColor};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px">View Notice</a>
  </div>`
}

/**
 * Fan out in-app + email deliveries for a published notice. Fully idempotent:
 * notice_deliveries has a UNIQUE(notice_id, employee_id, channel), so repeated
 * cron runs never create duplicate rows and only re-attempt failed emails.
 */
export async function dispatchNotice(noticeId: number, baseUrl: string | null = null) {
  const notice = (await query<any[]>("SELECT * FROM notices WHERE id = ? LIMIT 1", [noticeId]))[0]
  if (!notice || notice.status !== "published") return { inApp: 0, emailSent: 0, emailFailed: 0 }

  const recipients = await query<{ employee_id: number }[]>(
    "SELECT employee_id FROM notice_recipients WHERE notice_id = ?",
    [noticeId],
  )

  let inApp = 0, emailSent = 0, emailFailed = 0

  // In-app: one delivery row per recipient (the employee view reads these).
  if (notice.notify_in_app) {
    for (const r of recipients) {
      const res: any = await query(
        `INSERT IGNORE INTO notice_deliveries (notice_id, employee_id, channel, status, sent_at)
         VALUES (?, ?, 'in_app', 'sent', NOW())`,
        [noticeId, r.employee_id],
      )
      if (res?.affectedRows) inApp++
    }
  }

  // Email: create a delivery row (created), then attempt send and mark sent/failed.
  if (notice.notify_email) {
    const emps = await query<EmployeeIdentity[]>(
      `SELECT id, employee_name, COALESCE(official_email, personal_email) AS email
         FROM hr_employees WHERE id IN (${recipients.length ? recipients.map(() => "?").join(",") : "NULL"})`,
      recipients.map((r) => r.employee_id),
    )
    const configured = isEmailConfigured()
    for (const e of emps) {
      if (!e.email) continue
      // Claim the delivery slot (dedup).
      const claim: any = await query(
        `INSERT IGNORE INTO notice_deliveries (notice_id, employee_id, channel, status) VALUES (?, ?, 'email', 'created')`,
        [noticeId, e.id],
      )
      // Only send if we just created it OR a prior attempt failed.
      const row = (await query<any[]>(
        "SELECT status FROM notice_deliveries WHERE notice_id = ? AND employee_id = ? AND channel = 'email' LIMIT 1",
        [noticeId, e.id],
      ))[0]
      if (row?.status === "sent") continue
      if (!claim?.affectedRows && row?.status === "created") {
        // another worker is handling it; skip to avoid a duplicate email
        if (!configured) { /* fallthrough to mark failed below */ }
      }
      if (!configured) {
        await query(
          "UPDATE notice_deliveries SET status='failed', error='SMTP not configured', attempts=attempts+1 WHERE notice_id=? AND employee_id=? AND channel='email'",
          [noticeId, e.id],
        )
        emailFailed++
        continue
      }
      try {
        await sendEmail({
          to: e.email,
          subject: `[Notice] ${notice.heading}`,
          html: buildEmailHtml({
            employee_name: e.employee_name,
            title: notice.heading,
            category: notice.category,
            priority: notice.priority,
            publish_date: fmtDate(notice.published_at || notice.publish_date),
            expiry_date: fmtDate(notice.end_date),
            notice_link: noticeLink(baseUrl),
          }),
        })
        await query(
          "UPDATE notice_deliveries SET status='sent', sent_at=NOW(), attempts=attempts+1, error=NULL WHERE notice_id=? AND employee_id=? AND channel='email'",
          [noticeId, e.id],
        )
        emailSent++
      } catch (err: any) {
        await query(
          "UPDATE notice_deliveries SET status='failed', error=?, attempts=attempts+1 WHERE notice_id=? AND employee_id=? AND channel='email'",
          [String(err?.message ?? "send failed").slice(0, 500), noticeId, e.id],
        )
        emailFailed++
      }
    }
  }

  return { inApp, emailSent, emailFailed }
}

function fmtDate(v: string | null | undefined) {
  if (!v) return "-"
  const d = new Date(String(v).replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

// ---------------------------------------------------------------------------
// Read + acknowledgement (idempotent, concurrency-safe via UNIQUE keys)
// ---------------------------------------------------------------------------
export async function markRead(noticeId: number, employeeId: number) {
  await query("INSERT IGNORE INTO notice_reads (notice_id, employee_id) VALUES (?, ?)", [noticeId, employeeId])
}
export async function acknowledge(noticeId: number, employeeId: number) {
  await query("INSERT IGNORE INTO notice_acknowledgements (notice_id, employee_id) VALUES (?, ?)", [noticeId, employeeId])
}

/** Is this employee a valid recipient of the notice? (server-side visibility) */
export async function employeeCanSee(noticeId: number, emp: EmployeeIdentity | null): Promise<boolean> {
  const notice = (await query<any[]>("SELECT * FROM notices WHERE id = ? LIMIT 1", [noticeId]))[0]
  if (!notice) return false
  if (notice.to_type === "clients") return false
  if (!["published", "expired", "archived"].includes(notice.status)) return false
  if (!emp) {
    // Only unfinalized legacy all-employee notices are visible to unlinked users.
    return !notice.recipients_finalized && (!notice.department || notice.department === "")
  }
  const rec = await query<{ id: number }[]>(
    "SELECT id FROM notice_recipients WHERE notice_id = ? AND employee_id = ? LIMIT 1",
    [noticeId, emp.id],
  )
  if (rec.length) return true
  // Legacy fallback for notices published before recipients were materialized.
  if (!notice.recipients_finalized) {
    return !notice.department || notice.department === "" || notice.department === emp.department
  }
  return false
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------
export async function getAnalytics(noticeId: number) {
  const [[recipients], [reads], [acks], [emailSent], [emailFailed], [inApp]] = await Promise.all([
    query<any[]>("SELECT COUNT(*) AS c FROM notice_recipients WHERE notice_id = ?", [noticeId]),
    query<any[]>("SELECT COUNT(*) AS c FROM notice_reads WHERE notice_id = ?", [noticeId]),
    query<any[]>("SELECT COUNT(*) AS c FROM notice_acknowledgements WHERE notice_id = ?", [noticeId]),
    query<any[]>("SELECT COUNT(*) AS c FROM notice_deliveries WHERE notice_id = ? AND channel='email' AND status='sent'", [noticeId]),
    query<any[]>("SELECT COUNT(*) AS c FROM notice_deliveries WHERE notice_id = ? AND channel='email' AND status='failed'", [noticeId]),
    query<any[]>("SELECT COUNT(*) AS c FROM notice_deliveries WHERE notice_id = ? AND channel='in_app' AND status='sent'", [noticeId]),
  ])
  const totalRecipients = recipients.c ?? 0
  const readCount = reads.c ?? 0
  const ackCount = acks.c ?? 0
  return {
    totalRecipients,
    read: readCount,
    unread: Math.max(0, totalRecipients - readCount),
    acknowledged: ackCount,
    pending: Math.max(0, totalRecipients - ackCount),
    emailSent: emailSent.c ?? 0,
    emailFailed: emailFailed.c ?? 0,
    inAppSent: inApp.c ?? 0,
  }
}

/** Per-recipient read/ack breakdown for the analytics dialog. */
export async function getRecipientStatus(noticeId: number) {
  return query<any[]>(
    `SELECT e.id, e.employee_name, e.department, e.designation,
            r.read_at, a.acknowledged_at
       FROM notice_recipients nr
       JOIN hr_employees e ON e.id = nr.employee_id
       LEFT JOIN notice_reads r ON r.notice_id = nr.notice_id AND r.employee_id = nr.employee_id
       LEFT JOIN notice_acknowledgements a ON a.notice_id = nr.notice_id AND a.employee_id = nr.employee_id
      WHERE nr.notice_id = ?
      ORDER BY e.employee_name`,
    [noticeId],
  )
}

// ---------------------------------------------------------------------------
// Automation (cron): publish scheduled, expire, unpin, remind, retry email
// ---------------------------------------------------------------------------
export async function runNoticeAutomation(baseUrl: string | null = null) {
  await ensureNoticeSchema()
  const result = { published: 0, expired: 0, unpinned: 0, reminders: 0, emailRetried: 0, dispatched: 0 }

  // 1) Auto-publish scheduled notices whose publish time has arrived.
  const due = await query<any[]>(
    "SELECT * FROM notices WHERE status = 'scheduled' AND publish_date IS NOT NULL AND publish_date <= NOW()",
  )
  for (const n of due) {
    // Concurrency-safe transition: only one worker flips it to published.
    const upd: any = await query(
      "UPDATE notices SET status = 'published', published_at = NOW() WHERE id = ? AND status = 'scheduled'",
      [n.id],
    )
    if (!upd?.affectedRows) continue
    if (!n.recipients_finalized) await materializeRecipients(n.id, { ...n, status: "published" })
    await audit(n.id, null, "auto_published", "Published by scheduler")
    const d = await dispatchNotice(n.id, baseUrl)
    result.published++
    result.dispatched += d.inApp + d.emailSent
  }

  // 2) Auto-expire published notices past their end date.
  const expiredUpd: any = await query(
    `UPDATE notices SET status = 'expired', expired_at = NOW()
     WHERE status = 'published' AND end_date IS NOT NULL AND end_date < CURDATE()`,
  )
  result.expired = expiredUpd?.affectedRows ?? 0

  // 3) Auto-unpin expired notices unless explicitly configured to stay pinned.
  const unpinUpd: any = await query(
    `UPDATE notices SET pinned = 0
     WHERE pinned = 1 AND status = 'expired' AND keep_pinned_after_expiry = 0`,
  )
  result.unpinned = unpinUpd?.affectedRows ?? 0

  // 4) Retry failed emails from earlier dispatches (still-published notices).
  const retryTargets = await query<{ notice_id: number }[]>(
    `SELECT DISTINCT d.notice_id FROM notice_deliveries d
       JOIN notices n ON n.id = d.notice_id
      WHERE d.channel = 'email' AND d.status = 'failed' AND d.attempts < 5 AND n.status = 'published'`,
  )
  for (const t of retryTargets) {
    const d = await dispatchNotice(t.notice_id, baseUrl)
    result.emailRetried += d.emailSent
  }

  // 5) Acknowledgement reminders for pending recipients (deduped per tier/day).
  const ackNotices = await query<any[]>(
    `SELECT * FROM notices
      WHERE status = 'published' AND acknowledgement_required = 1
        AND published_at IS NOT NULL AND published_at <= (NOW() - INTERVAL 1 DAY)`,
  )
  for (const n of ackNotices) {
    const pending = await query<EmployeeIdentity[]>(
      `SELECT e.id, e.employee_name, COALESCE(e.official_email, e.personal_email) AS email
         FROM notice_recipients nr
         JOIN hr_employees e ON e.id = nr.employee_id
         LEFT JOIN notice_acknowledgements a ON a.notice_id = nr.notice_id AND a.employee_id = nr.employee_id
        WHERE nr.notice_id = ? AND a.id IS NULL`,
      [n.id],
    )
    // Reminder tier = number of days since publish (capped at 5), one per day.
    const daysSince = Math.floor((Date.now() - new Date(String(n.published_at).replace(" ", "T")).getTime()) / 86400000)
    const reminderNo = Math.min(daysSince, 5)
    if (reminderNo < 1) continue
    for (const e of pending) {
      const claim: any = await query(
        "INSERT IGNORE INTO notice_reminders (notice_id, employee_id, reminder_no) VALUES (?, ?, ?)",
        [n.id, e.id, reminderNo],
      )
      if (!claim?.affectedRows) continue
      result.reminders++
      await audit(n.id, null, "ack_reminder", `Reminder #${reminderNo} to employee ${e.id}`)
      if (n.notify_email && e.email && isEmailConfigured()) {
        try {
          await sendEmail({
            to: e.email,
            subject: `[Reminder] Please acknowledge: ${n.heading}`,
            html: buildEmailHtml({
              employee_name: e.employee_name,
              title: n.heading,
              category: n.category,
              priority: n.priority,
              publish_date: fmtDate(n.published_at),
              expiry_date: fmtDate(n.end_date),
              notice_link: noticeLink(baseUrl),
            }),
          })
        } catch (err) {
          console.error("[notice-board] reminder email failed", (err as any)?.message)
        }
      }
    }
  }

  return result
}
