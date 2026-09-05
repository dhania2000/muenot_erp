import nodemailer from "nodemailer"
import crypto from "crypto"
import { query } from "@/lib/db"

let tablesEnsured = false

/**
 * Self-healing: create the email feature tables if they don't exist yet.
 * This keeps the feature working even when the SQL migration hasn't been
 * run manually in phpMyAdmin. Safe to call on every request (it short-circuits
 * after the first success within a process).
 */
export async function ensureEmailTables() {
  if (tablesEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS sales_email_templates (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(150) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      body MEDIUMTEXT NOT NULL,
      category VARCHAR(80) DEFAULT NULL,
      created_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_email_templates_created_by (created_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS sales_emails (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      lead_id INT UNSIGNED DEFAULT NULL,
      template_id INT UNSIGNED DEFAULT NULL,
      to_email VARCHAR(190) NOT NULL,
      to_name VARCHAR(190) DEFAULT NULL,
      subject VARCHAR(255) NOT NULL,
      body MEDIUMTEXT NOT NULL,
      tracking_token VARCHAR(64) NOT NULL,
      status ENUM('Sent','Failed','Opened') NOT NULL DEFAULT 'Sent',
      error_message VARCHAR(500) DEFAULT NULL,
      open_count INT UNSIGNED NOT NULL DEFAULT 0,
      first_opened_at DATETIME DEFAULT NULL,
      last_opened_at DATETIME DEFAULT NULL,
      sent_by INT UNSIGNED DEFAULT NULL,
      sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_email_token (tracking_token),
      KEY idx_emails_lead (lead_id),
      KEY idx_emails_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS sales_email_events (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      email_id INT UNSIGNED NOT NULL,
      event_type VARCHAR(30) NOT NULL DEFAULT 'open',
      user_agent VARCHAR(400) DEFAULT NULL,
      ip_address VARCHAR(60) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_events_email (email_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // --- Threading columns (added idempotently so existing installs upgrade) ---
  // thread_id groups every email to the same lead/recipient into one conversation.
  // message_id / in_reply_to / references_header carry the RFC 5322 headers that
  // make mail clients (Gmail, Outlook, etc.) stack follow-ups in the same thread.
  await ensureColumn("sales_emails", "message_id", "VARCHAR(255) DEFAULT NULL")
  await ensureColumn("sales_emails", "in_reply_to", "VARCHAR(255) DEFAULT NULL")
  await ensureColumn("sales_emails", "references_header", "TEXT DEFAULT NULL")
  await ensureColumn("sales_emails", "thread_id", "VARCHAR(160) DEFAULT NULL")
  // recipient_key identifies the person, independent of individual conversations.
  // A recipient can now have many thread_ids: each "New" email starts a fresh one,
  // and each "Follow Up" joins the recipient's most recent thread.
  await ensureColumn("sales_emails", "recipient_key", "VARCHAR(120) DEFAULT NULL")
  await ensureIndex("sales_emails", "idx_emails_thread", "thread_id")
  await ensureIndex("sales_emails", "idx_emails_recipient", "recipient_key")

  // Backfill recipient_key for any legacy rows that predate this column.
  await query(
    `UPDATE sales_emails
     SET recipient_key = CASE
       WHEN lead_id IS NOT NULL THEN CONCAT('lead:', lead_id)
       ELSE CONCAT('addr:', LOWER(to_email))
     END
     WHERE recipient_key IS NULL`,
  )
  // Backfill a stable thread_id for any legacy rows that predate threading.
  // Legacy rows keep the recipient-level grouping they already had.
  await query(
    `UPDATE sales_emails
     SET thread_id = recipient_key
     WHERE thread_id IS NULL`,
  )

  tablesEnsured = true
}

/** Add a column only if it doesn't already exist (MySQL has no ADD COLUMN IF NOT EXISTS). */
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

/** Add an index only if it doesn't already exist. */
async function ensureIndex(table: string, indexName: string, column: string) {
  const rows = await query<any[]>(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, indexName],
  )
  if (rows.length === 0) {
    await query(`ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` (\`${column}\`)`)
  }
}

/** Stable key that identifies a recipient (person), independent of conversations. */
export function buildRecipientKey(leadId: number | string | null | undefined, toEmail: string) {
  if (leadId) return `lead:${leadId}`
  return `addr:${toEmail.trim().toLowerCase()}`
}

/** Build a brand-new, unique thread id for a fresh conversation with a recipient. */
export function buildNewThreadId(recipientKey: string, token: string) {
  return `${recipientKey}:${token}`
}

/**
 * Find the most recent thread id for a recipient. Follow-ups reuse this so they
 * land in the conversation of the last email sent to that person. Returns null
 * when the recipient has never been emailed before.
 */
export async function getLatestThreadId(recipientKey: string): Promise<string | null> {
  const rows = await query<any[]>(
    `SELECT thread_id FROM sales_emails
     WHERE recipient_key = ? AND thread_id IS NOT NULL
     ORDER BY sent_at DESC, id DESC
     LIMIT 1`,
    [recipientKey],
  )
  return rows[0]?.thread_id ?? null
}

/** Resolve the domain used inside generated Message-ID headers. */
function resolveMailDomain() {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || ""
  const match = from.match(/@([^\s>]+)/)
  if (match) return match[1]
  const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
  if (appUrl) {
    try {
      return new URL(appUrl).hostname
    } catch {
      /* ignore */
    }
  }
  return "muenot.local"
}

/** Generate a globally-unique RFC 5322 Message-ID for an outgoing email. */
export function buildMessageId(token: string) {
  return `<${token}.${Date.now()}@${resolveMailDomain()}>`
}

export type ThreadContext = {
  inReplyTo: string
  references: string
  rootSubject: string
}

/** Strip any leading "Re:" prefixes so we can build a single clean threaded subject. */
export function baseSubject(subject: string) {
  return subject.replace(/^(\s*re\s*:\s*)+/i, "").trim()
}

/**
 * Look up the prior messages in a thread so a follow-up can reference them.
 * Returns null when this is the first email in the thread.
 */
export async function getThreadContext(threadId: string): Promise<ThreadContext | null> {
  const rows = await query<any[]>(
    `SELECT message_id, subject FROM sales_emails
     WHERE thread_id = ? AND message_id IS NOT NULL
     ORDER BY sent_at ASC, id ASC`,
    [threadId],
  )
  if (rows.length === 0) return null
  const messageIds = rows.map((r) => r.message_id).filter(Boolean)
  const last = rows[rows.length - 1]
  return {
    inReplyTo: last.message_id,
    references: messageIds.join(" "),
    rootSubject: rows[0].subject,
  }
}

// SMTP transport configured via environment variables.
// Add these to .env.local (locally) or your Hostinger hosting panel:
//   SMTP_HOST     - e.g. smtp.hostinger.com
//   SMTP_PORT     - e.g. 465 (SSL) or 587 (TLS)
//   SMTP_SECURE   - "true" for port 465, "false" for 587
//   SMTP_USER     - the mailbox / SMTP username
//   SMTP_PASS     - the mailbox / SMTP password
//   SMTP_FROM     - default From address, e.g. "Muenot Sales <sales@muenot.co.in>"
//   APP_URL       - public base URL of this app, used to build the tracking
//                   pixel link, e.g. https://erp.muenot.co.in

const transporters = new Map<string, nodemailer.Transporter>()

type Department = "sales" | "hr" | "finance" | "operations"

export async function hydrateDepartmentSMTP(department: Department = "sales") {
  const prefix = department.toUpperCase()
  const names = [`${prefix}_SMTP_HOST`, `${prefix}_SMTP_PORT`, `${prefix}_SMTP_SECURE`, `${prefix}_SMTP_USER`, `${prefix}_SMTP_PASS`, `${prefix}_SMTP_FROM`]
  const rows = await query<any[]>(`SELECT name, value_encrypted FROM environment_variables WHERE name IN (${names.map(() => "?").join(",")})`, names)
  const secret = process.env.SETTINGS_ENCRYPTION_KEY
  if (!secret) return
  const key = crypto.createHash("sha256").update(secret).digest()
  for (const row of rows) {
    const payload = Buffer.isBuffer(row.value_encrypted) ? row.value_encrypted : Buffer.from(row.value_encrypted, "base64")
    if (payload.length < 28) continue
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12))
    decipher.setAuthTag(payload.subarray(12, 28))
    process.env[row.name] = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8")
  }
}
function smtpConfig(department: Department = "sales") {
  const prefix = department.toUpperCase()
  return {
    host: process.env[`${prefix}_SMTP_HOST`] || process.env.SMTP_HOST,
    port: Number(process.env[`${prefix}_SMTP_PORT`] || process.env.SMTP_PORT || 587),
    secure: String(process.env[`${prefix}_SMTP_SECURE`] || process.env.SMTP_SECURE || "false") === "true",
    user: process.env[`${prefix}_SMTP_USER`] || process.env.SMTP_USER,
    pass: process.env[`${prefix}_SMTP_PASS`] || process.env.SMTP_PASS,
    from: process.env[`${prefix}_SMTP_FROM`] || process.env.SMTP_FROM,
  }
}

export function isEmailConfigured(department: Department = "sales") {
  const config = smtpConfig(department)
  return Boolean(config.host && config.user && config.pass)
}

function getTransporter(department: Department = "sales") {
  const config = smtpConfig(department)
  const cacheKey = `${department}:${config.host}:${config.port}:${config.user}`
  const existing = transporters.get(cacheKey)
  if (existing) return existing
  const created = nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure, auth: { user: config.user, pass: config.pass } })
  transporters.set(cacheKey, created)
  return created
}

export function generateTrackingToken() {
  return crypto.randomBytes(24).toString("hex")
}

/** Resolve the public base URL used for the tracking pixel. */
export function resolveBaseUrl(request: Request) {
  const fromEnv = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
  if (fromEnv) return fromEnv.replace(/\/$/, "")
  // Fall back to the incoming request origin.
  const url = new URL(request.url)
  const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "")
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || url.host
  return `${proto}://${host}`
}

/**
 * Build the final HTML with an invisible 1x1 tracking pixel appended.
 * The recipient cannot tell the pixel is there — it renders as a blank 1px image.
 */
export function withTrackingPixel(html: string, baseUrl: string, token: string) {
  const pixel = `<img src="${baseUrl}/api/track/${token}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;outline:none;" />`
  return `${html}${pixel}`
}

/** Merge {{field}} placeholders in a template with lead values. */
export function renderTemplate(text: string, vars: Record<string, string | null | undefined>) {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    const val = vars[key]
    return val != null && val !== "" ? String(val) : ""
  })
}

/** Extract the bare email address out of either "user@x.com" or "Name <user@x.com>". */
function extractEmailAddress(value: string | undefined | null) {
  if (!value) return ""
  const match = value.match(/<([^>]+)>/)
  return (match ? match[1] : value).trim()
}

/**
 * Build the RFC 5322 "From" header. Sales mail always displays as
 * "Muenot Business Team" regardless of whatever display name (or none) is
 * stored in the SMTP "from" setting — only the underlying mailbox address
 * is kept. Other departments keep whatever display name is configured.
 */
function buildFromHeader(department: Department | undefined, configuredFrom: string | undefined) {
  const address = extractEmailAddress(configuredFrom)
  if (!address) return configuredFrom
  if (department === "sales") return `Muenot Business Team <${address}>`
  return configuredFrom
}

export async function sendEmail(opts: {
  to: string
  from?: string
  subject: string
  html: string
  /** RFC 5322 threading headers — set these to keep follow-ups in one conversation. */
  messageId?: string
  inReplyTo?: string
  references?: string
  /** Extra RFC 5322 headers, e.g. X-Entity-Ref-ID to control Gmail thread grouping. */
  headers?: Record<string, string>
  department?: Department
  /** Attach a calendar invite so mail clients show an "Add to calendar" card. */
  icalEvent?: { method: string; content: string; filename?: string }
}) {
  const config = smtpConfig(opts.department)
  const configuredFrom = opts.from || config.from || config.user
  const from = buildFromHeader(opts.department, configuredFrom)
  const info = await getTransporter(opts.department).sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    messageId: opts.messageId,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
    headers: opts.headers,
    icalEvent: opts.icalEvent
      ? {
          method: opts.icalEvent.method,
          filename: opts.icalEvent.filename || "invite.ics",
          content: opts.icalEvent.content,
        }
      : undefined,
  })
  return info
}
