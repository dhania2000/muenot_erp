import nodemailer, { type Transporter } from "nodemailer"
import MailComposer from "nodemailer/lib/mail-composer"
import { google } from "googleapis"
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

  // --- Attachment columns on templates (added idempotently) ---
  // Templates can carry a single stored attachment (referenced by its
  // /api/email-attachments/<id> pathname) that travels with every email sent
  // from the template.
  await ensureColumn("sales_email_templates", "attachment_pathname", "VARCHAR(255) DEFAULT NULL")
  await ensureColumn("sales_email_templates", "attachment_name", "VARCHAR(255) DEFAULT NULL")
  await ensureColumn("sales_email_templates", "attachment_type", "VARCHAR(150) DEFAULT NULL")
  await ensureColumn("sales_email_templates", "attachment_size", "INT UNSIGNED DEFAULT NULL")

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
  // provider_thread_id stores the Gmail API conversation id returned when a
  // message is sent. Gmail ONLY groups a follow-up into an existing conversation
  // when this id is passed back in the send request — the RFC In-Reply-To /
  // References headers alone are not enough for Gmail's own web/app view.
  // Reusing it is what keeps follow-ups in the same Gmail thread as the original.
  await ensureColumn("sales_emails", "provider_thread_id", "VARCHAR(190) DEFAULT NULL")
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

let recruitTablesEnsured = false

/**
 * Self-healing tables for the Recruit module's email feature. Mirrors
 * ensureEmailTables but scoped to recruit_email_templates + recruit_emails.
 */
export async function ensureRecruitEmailTables() {
  if (recruitTablesEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS recruit_email_templates (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(150) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      body MEDIUMTEXT NOT NULL,
      category VARCHAR(80) DEFAULT NULL,
      attachment_pathname VARCHAR(255) DEFAULT NULL,
      attachment_name VARCHAR(255) DEFAULT NULL,
      attachment_type VARCHAR(150) DEFAULT NULL,
      attachment_size INT UNSIGNED DEFAULT NULL,
      created_by INT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_recruit_templates_created_by (created_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await query(
    `CREATE TABLE IF NOT EXISTS recruit_emails (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      application_id VARCHAR(40) DEFAULT NULL,
      template_id INT UNSIGNED DEFAULT NULL,
      to_email VARCHAR(190) NOT NULL,
      to_name VARCHAR(190) DEFAULT NULL,
      subject VARCHAR(255) NOT NULL,
      body MEDIUMTEXT NOT NULL,
      status ENUM('Sent','Failed') NOT NULL DEFAULT 'Sent',
      error_message VARCHAR(500) DEFAULT NULL,
      sent_by INT UNSIGNED DEFAULT NULL,
      sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_recruit_emails_app (application_id),
      KEY idx_recruit_emails_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  recruitTablesEnsured = true
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

/**
 * Find the most recent thread id for a recipient identified purely by their
 * EMAIL ADDRESS, independent of whether (or which) lead was linked on the
 * earlier email. This is what a follow-up must use: the recipient is the same
 * person whether their previous message was a New email, a bulk send, or
 * another follow-up, and whether or not it was linked to a lead. Matching on
 * the lead-based recipient_key instead would miss the last email whenever the
 * lead linkage differed between the two sends, causing the follow-up to start a
 * brand-new (separate) thread. Failed sends are ignored so the follow-up
 * anchors on an email that actually went out. Returns null when the address has
 * never been successfully emailed before.
 */
export async function getLatestThreadIdByEmail(toEmail: string): Promise<string | null> {
  const email = (toEmail || "").trim().toLowerCase()
  if (!email) return null
  const rows = await query<any[]>(
    `SELECT thread_id FROM sales_emails
     WHERE LOWER(to_email) = ? AND thread_id IS NOT NULL AND status <> 'Failed'
     ORDER BY sent_at DESC, id DESC
     LIMIT 1`,
    [email],
  )
  return rows[0]?.thread_id ?? null
}

/**
 * Resolve the domain used inside generated Message-ID headers. Uses the
 * department's real sender mailbox (Gmail API sender, then SMTP from/user) so
 * the Message-ID domain matches the From address — Gmail keeps a supplied
 * Message-ID only when it is well-formed and plausible, and the recipient's
 * mailbox threads follow-ups by matching this exact id via In-Reply-To.
 */
function resolveMailDomain(department: Department = "sales") {
  const gmail = gmailApiConfig(department)
  const smtp = smtpConfig(department)
  const candidates = [gmail.sender, smtp.from, smtp.user, process.env.SMTP_FROM, process.env.SMTP_USER]
  for (const candidate of candidates) {
    const match = (candidate || "").match(/@([^\s>]+)/)
    if (match) return match[1]
  }
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
export function buildMessageId(token: string, department: Department = "sales") {
  return `<${token}.${Date.now()}@${resolveMailDomain(department)}>`
}

export type ThreadContext = {
  inReplyTo: string
  references: string
  rootSubject: string
  /** Gmail API conversation id, when the thread was sent via the Gmail API. */
  providerThreadId: string | null
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
    `SELECT message_id, subject, provider_thread_id FROM sales_emails
     WHERE thread_id = ? AND message_id IS NOT NULL
     ORDER BY sent_at ASC, id ASC`,
    [threadId],
  )
  if (rows.length === 0) return null
  const messageIds = rows.map((r) => r.message_id).filter(Boolean)
  const last = rows[rows.length - 1]
  // Every message in a Gmail conversation shares the same provider thread id,
  // so the most recent non-null value identifies the conversation to rejoin.
  const providerThreadId = [...rows].reverse().find((r) => r.provider_thread_id)?.provider_thread_id ?? null
  return {
    inReplyTo: last.message_id,
    references: messageIds.join(" "),
    rootSubject: rows[0].subject,
    providerThreadId,
  }
}

export type OutgoingAttachment = { filename: string; content: Buffer; contentType?: string }

/**
 * Load a stored attachment (uploaded via /api/email-attachments) by its
 * public pathname, e.g. "/api/email-attachments/<uuid>". Returns a
 * nodemailer-ready attachment, or null when the file can't be found.
 */
export async function loadAttachment(
  pathname: string | null | undefined,
): Promise<OutgoingAttachment | null> {
  if (!pathname) return null
  const id = pathname.split("/").filter(Boolean).pop()
  if (!id) return null
  const rows = await query<any[]>(
    `SELECT filename, content_type, data FROM email_attachments WHERE id = ? LIMIT 1`,
    [id],
  )
  const row = rows[0]
  if (!row) return null
  const content = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data)
  return { filename: row.filename, content, contentType: row.content_type || undefined }
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

const transporters = new Map<string, Transporter>()

type Department = "sales" | "hr" | "finance" | "operations" | "recruit"

export async function hydrateDepartmentSMTP(department: Department = "sales") {
  const prefix = department.toUpperCase()
  const names = [
    `${prefix}_SMTP_HOST`,
    `${prefix}_SMTP_PORT`,
    `${prefix}_SMTP_SECURE`,
    `${prefix}_SMTP_USER`,
    `${prefix}_SMTP_PASS`,
    `${prefix}_SMTP_FROM`,
    // Gmail API (HTTPS) credentials — used on hosts that block outbound SMTP.
    `${prefix}_GMAIL_CLIENT_EMAIL`,
    `${prefix}_GMAIL_PRIVATE_KEY`,
    `${prefix}_GMAIL_SENDER`,
  ]
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

/**
 * Gmail API config. When a service-account client email + private key are
 * present, mail is sent over HTTPS (port 443) via the Gmail API instead of
 * SMTP. This is required on hosts (e.g. Hostinger shared hosting) that block
 * outbound SMTP ports 465/587, which otherwise surfaces as
 * "Timeout | code: ETIMEDOUT | command: CONN".
 *
 * Set up (per department, or generic GMAIL_* as a fallback):
 *   <DEPT>_GMAIL_CLIENT_EMAIL  - service account email
 *   <DEPT>_GMAIL_PRIVATE_KEY   - service account private key (with \n escapes)
 *   <DEPT>_GMAIL_SENDER        - the Workspace mailbox to send as / impersonate
 * The service account must have domain-wide delegation authorized in the
 * Google Workspace Admin console. Sending only requires:
 *   https://www.googleapis.com/auth/gmail.send
 * Follow-up threading additionally requires a read scope so we can read back
 * the real Message-ID Gmail assigns to each sent mail:
 *   https://www.googleapis.com/auth/gmail.readonly
 * These scopes are used by two SEPARATE clients on purpose: if the read scope
 * is not authorized, sending still works and only follow-up threading degrades
 * (follow-ups may open a new thread on the recipient side).
 */
function gmailApiConfig(department: Department = "sales") {
  const prefix = department.toUpperCase()
  const clientEmail = process.env[`${prefix}_GMAIL_CLIENT_EMAIL`] || process.env.GMAIL_CLIENT_EMAIL
  const privateKey = process.env[`${prefix}_GMAIL_PRIVATE_KEY`] || process.env.GMAIL_PRIVATE_KEY
  const smtp = smtpConfig(department)
  const sender =
    process.env[`${prefix}_GMAIL_SENDER`] ||
    process.env.GMAIL_SENDER ||
    extractEmailAddress(smtp.from) ||
    smtp.user
  return { clientEmail, privateKey, sender, from: smtp.from }
}

export function isGmailApiConfigured(department: Department = "sales") {
  const config = gmailApiConfig(department)
  return Boolean(config.clientEmail && config.privateKey && config.sender)
}

/**
 * Normalize a service-account private key into a clean PEM that OpenSSL 3 can
 * decode. Keys copied through env vars, JSON, or the settings UI arrive in many
 * broken shapes; a mismatch surfaces at sign time as
 * `error:1E08010C:DECODER routines::unsupported` (ERR_OSSL_UNSUPPORTED).
 *
 * This handles the common corruptions:
 *  - literal "\n" (single-escaped) and "\\n" (double-escaped) instead of real newlines
 *  - literal "\r" carriage returns and Windows "\r\n"
 *  - wrapping quotes left over from `KEY="-----BEGIN...-----"` style values
 *  - a whole JSON service-account blob pasted where only the key was expected
 *  - keys collapsed onto a single line with the PEM header/footer intact
 */
function normalizePrivateKey(raw: string): string {
  let key = (raw || "").trim()
  if (!key) return key

  // If the whole service-account JSON was pasted, pull out `private_key`.
  if (key.startsWith("{")) {
    try {
      const parsed = JSON.parse(key)
      if (typeof parsed.private_key === "string") key = parsed.private_key
    } catch {
      /* not JSON — fall through and treat as a raw key */
    }
  }

  // Strip a single pair of wrapping quotes (', ", or `).
  if (key.length >= 2 && /^['"`]/.test(key) && key.at(-1) === key[0]) {
    key = key.slice(1, -1)
  }

  // Turn every escaped-newline variant into a real newline, then drop CRs.
  // Collapse double-escaped sequences (literal backslash-backslash-n) first so
  // the following single-escape pass doesn't leave a stray backslash behind.
  key = key
    .replace(/\\\\r\\\\n/g, "\n")
    .replace(/\\\\n/g, "\n")
    .replace(/\\\\r/g, "\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()

  // If the key lost its line breaks but kept the PEM markers, rebuild the
  // 64-char base64 body between the header and footer.
  const pemMatch = key.match(/-----BEGIN ([A-Z ]+?)-----([\s\S]*?)-----END \1-----/)
  if (pemMatch && !pemMatch[2].includes("\n")) {
    const label = pemMatch[1]
    const body = pemMatch[2].replace(/\s+/g, "")
    const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body
    key = `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`
  }

  return key.endsWith("\n") ? key : `${key}\n`
}

const gmailClients = new Map<string, ReturnType<typeof google.gmail>>()

function getGmailClient(department: Department = "sales") {
  const config = gmailApiConfig(department)
  const cacheKey = `${department}:${config.clientEmail}:${config.sender}`
  const existing = gmailClients.get(cacheKey)
  if (existing) return existing

  const key = normalizePrivateKey(config.privateKey || "")

  // Fail early with a clear, actionable message instead of the opaque OpenSSL
  // "DECODER routines::unsupported" error that surfaces later at sign time.
  if (!/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(key)) {
    throw new Error(
      "Gmail private key is malformed: expected a PEM block beginning with " +
        "'-----BEGIN PRIVATE KEY-----'. Re-save the service-account key in " +
        "settings (paste the full key including the BEGIN/END lines).",
    )
  }

  const auth = new google.auth.JWT({
    email: config.clientEmail,
    key,
    // SEND ONLY. This scope must stay isolated: a service-account JWT that
    // requests any scope not authorized in the Workspace domain-wide delegation
    // fails token acquisition entirely (401 unauthorized_client), which would
    // break sending. The Message-ID read-back needed for follow-up threading
    // uses a SEPARATE client (getGmailReadClient) with the read scope so that,
    // if that read scope is not authorized, only threading degrades — sending
    // keeps working.
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    subject: config.sender,
  })
  const client = google.gmail({ version: "v1", auth })
  gmailClients.set(cacheKey, client)
  return client
}

const gmailReadClients = new Map<string, ReturnType<typeof google.gmail>>()

/**
 * A separate Gmail client authorized ONLY for reading message metadata. Kept
 * apart from the send client on purpose (see getGmailClient): if the
 * gmail.readonly scope is not authorized in the Workspace domain-wide
 * delegation, calls on this client fail with 401/403 but sending is unaffected.
 * Used to read back the real Message-ID Gmail assigns to a sent message so
 * follow-ups reference the exact id the recipient received and thread correctly.
 */
function getGmailReadClient(department: Department = "sales") {
  const config = gmailApiConfig(department)
  const cacheKey = `${department}:${config.clientEmail}:${config.sender}`
  const existing = gmailReadClients.get(cacheKey)
  if (existing) return existing

  const key = normalizePrivateKey(config.privateKey || "")
  if (!/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(key)) {
    throw new Error("Gmail private key is malformed")
  }

  const auth = new google.auth.JWT({
    email: config.clientEmail,
    key,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    subject: config.sender,
  })
  const client = google.gmail({ version: "v1", auth })
  gmailReadClients.set(cacheKey, client)
  return client
}

/** Compose a full RFC 2822 MIME message (headers, body, attachments) as a Buffer. */
function composeMime(mailOptions: Record<string, unknown>) {
  return new Promise<Buffer>((resolve, reject) => {
    new MailComposer(mailOptions).compile().build((err: Error | null, message: Buffer) => {
      if (err) reject(err)
      else resolve(message)
    })
  })
}

export function isEmailConfigured(department: Department = "sales") {
  if (isGmailApiConfigured(department)) return true
  const config = smtpConfig(department)
  return Boolean(config.host && config.user && config.pass)
}

function getTransporter(department: Department = "sales") {
  const config = smtpConfig(department)
  const cacheKey = `${department}:${config.host}:${config.port}:${config.user}`
  const existing = transporters.get(cacheKey)
  if (existing) return existing
  const created = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    // Fail fast instead of hanging forever when the SMTP host is unreachable,
    // blocked, or misconfigured. Without these, sendMail() never rejects and
    // the compose dialog's "Send email" button spins indefinitely.
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  })
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
  /** File attachments to include with the email. */
  attachments?: OutgoingAttachment[]
  /** Attach a calendar invite so mail clients show an "Add to calendar" card. */
  icalEvent?: { method: string; content: string; filename?: string }
  /**
   * Gmail API conversation id to join. Set on follow-ups so Gmail groups the
   * message into the original conversation instead of starting a new thread.
   */
  providerThreadId?: string | null
}): Promise<{ messageId?: string; providerThreadId?: string | null }> {
  const config = smtpConfig(opts.department)
  const configuredFrom = opts.from || config.from || config.user
  const from = buildFromHeader(opts.department, configuredFrom)

  const attachments = opts.attachments?.length
    ? opts.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType }))
    : undefined
  const icalEvent = opts.icalEvent
    ? {
        method: opts.icalEvent.method,
        filename: opts.icalEvent.filename || "invite.ics",
        content: opts.icalEvent.content,
      }
    : undefined

  const mailOptions = {
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    messageId: opts.messageId,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
    headers: opts.headers,
    attachments,
    icalEvent,
  }

  // Prefer the Gmail API (HTTPS) when configured. This bypasses SMTP port
  // blocks on shared hosting that cause ETIMEDOUT/CONN. The message is composed
  // with the exact same headers (threading, attachments, tracking) and sent
  // over port 443, so recipients see no difference.
  if (isGmailApiConfigured(opts.department)) {
    const raw = await composeMime(mailOptions)
    const encoded = raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    const gmail = getGmailClient(opts.department)
    const res = await gmail.users.messages.send({
      userId: "me",
      // Passing threadId is what makes Gmail place a follow-up in the SAME
      // conversation as the original. Without it Gmail always opens a new
      // thread, even with correct In-Reply-To/References headers.
      requestBody: opts.providerThreadId
        ? { raw: encoded, threadId: opts.providerThreadId }
        : { raw: encoded },
    })

    // Gmail REWRITES the outgoing Message-ID header, discarding the one we put
    // in the MIME and stamping its own (<...@mail.gmail.com>). The recipient's
    // mailbox only ever sees Gmail's value, so a follow-up whose In-Reply-To /
    // References point at OUR generated id references a message that never
    // existed on the recipient side — which is exactly why Gmail refuses to
    // thread the follow-up. Read the message back and capture the real
    // Message-ID so future follow-ups can reference the id the recipient
    // actually received.
    let realMessageId = opts.messageId
    if (res.data.id) {
      try {
        // Use the SEPARATE read-only client so an unauthorized read scope can
        // never affect the send above. getGmailReadClient() itself may throw
        // (e.g. malformed key), so it is inside the try too.
        const readClient = getGmailReadClient(opts.department)
        const sent = await readClient.users.messages.get({
          userId: "me",
          id: res.data.id,
          format: "metadata",
          metadataHeaders: ["Message-ID", "Message-Id"],
        })
        const header = (sent.data.payload?.headers || []).find(
          (h) => (h.name || "").toLowerCase() === "message-id",
        )?.value
        if (header) {
          realMessageId = header
          console.log("[v0] Captured real Gmail Message-ID for threading:", header)
        } else {
          console.warn("[v0] Gmail read-back returned no Message-ID header; using generated id", opts.messageId)
        }
      } catch (err) {
        // Non-fatal: fall back to our generated id. The send already succeeded,
        // so we never fail the request over this. A 401 unauthorized_client or
        // 403 here means the gmail.readonly scope is not yet authorized in the
        // Workspace domain-wide delegation for the service account.
        console.error(
          "[v0] Could not read back Gmail Message-ID (follow-ups may not thread). " +
            "Authorize the gmail.readonly scope for the service account in " +
            "Workspace Admin > domain-wide delegation:",
          (err as any)?.message,
        )
      }
    }

    // Capture the conversation id so the first email in a thread can persist it
    // and later follow-ups can rejoin the same Gmail thread.
    return { messageId: realMessageId, providerThreadId: res.data.threadId ?? opts.providerThreadId ?? null }
  }

  const info = await getTransporter(opts.department).sendMail(mailOptions)
  return { ...info, providerThreadId: null }
}
