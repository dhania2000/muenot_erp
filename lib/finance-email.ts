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
 * Central service for the Finance Email Hub — the finance-side mirror of
 * lib/hr-email.ts. Every finance email (composed, sent, drafted, scheduled, or
 * fired by an automation rule) flows through here so it lands in one
 * `finance_emails` table with a stable Email ID, open tracking, and full
 * lifecycle bookkeeping. Reuses the shared transport layer in lib/email.ts.
 */

export {
  FINANCE_EMAIL_CATEGORIES,
  SENSITIVE_FINANCE_EMAIL_CATEGORIES,
  FINANCE_EMAIL_STATUSES,
} from "@/lib/finance-email-shared"
export type { FinanceEmailCategory, FinanceEmailStatus } from "@/lib/finance-email-shared"

import type { FinanceEmailStatus } from "@/lib/finance-email-shared"

const MAX_SEND_ATTEMPTS = 5

// ---------------------------------------------------------------------------
// Self-healing schema so the hub works even before the SQL migration is run.
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

export async function ensureFinanceEmailHubSchema() {
  if (schemaEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS finance_emails (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      to_email VARCHAR(320) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      body LONGTEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'Sent',
      sent_at DATETIME NULL,
      opened_at DATETIME NULL,
      created_by VARCHAR(100) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  await ensureColumn("finance_emails", "email_uid", "VARCHAR(40) NULL")
  await ensureColumn("finance_emails", "party_id", "BIGINT UNSIGNED NULL")
  await ensureColumn("finance_emails", "to_name", "VARCHAR(190) NULL")
  await ensureColumn("finance_emails", "cc", "TEXT NULL")
  await ensureColumn("finance_emails", "bcc", "TEXT NULL")
  await ensureColumn("finance_emails", "template_id", "BIGINT UNSIGNED NULL")
  await ensureColumn("finance_emails", "category", "VARCHAR(60) NOT NULL DEFAULT 'General'")
  await ensureColumn("finance_emails", "source_module", "VARCHAR(40) NOT NULL DEFAULT 'manual'")
  await ensureColumn("finance_emails", "source_record_id", "VARCHAR(64) NULL")
  await ensureColumn(
    "finance_emails",
    "email_type",
    "ENUM('Manual','Automated') NOT NULL DEFAULT 'Manual'",
  )
  await ensureColumn("finance_emails", "scheduled_at", "DATETIME NULL")
  await ensureColumn("finance_emails", "open_count", "INT NOT NULL DEFAULT 0")
  await ensureColumn("finance_emails", "attempts", "INT UNSIGNED NOT NULL DEFAULT 0")
  await ensureColumn("finance_emails", "last_error", "VARCHAR(500) NULL")
  await ensureColumn("finance_emails", "message_id", "VARCHAR(255) NULL")
  await ensureColumn("finance_emails", "thread_id", "VARCHAR(255) NULL")
  await ensureColumn("finance_emails", "dedupe_key", "VARCHAR(190) NULL")
  await ensureColumn("finance_emails", "attachment_pathname", "VARCHAR(255) NULL")
  await ensureColumn("finance_emails", "attachment_name", "VARCHAR(255) NULL")
  await ensureColumn("finance_emails", "attachment_type", "VARCHAR(150) NULL")
  await ensureColumn("finance_emails", "attachment_size", "INT UNSIGNED NULL")
  await ensureColumn(
    "finance_emails",
    "updated_at",
    "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
  )

  await ensureIndex(
    "finance_emails",
    "uq_finance_emails_uid",
    "UNIQUE KEY uq_finance_emails_uid (email_uid)",
  )
  await ensureIndex(
    "finance_emails",
    "uq_finance_emails_dedupe",
    "UNIQUE KEY uq_finance_emails_dedupe (dedupe_key)",
  )
  await ensureIndex(
    "finance_emails",
    "idx_finance_emails_status",
    "KEY idx_finance_emails_status (status)",
  )
  await ensureIndex(
    "finance_emails",
    "idx_finance_emails_category",
    "KEY idx_finance_emails_category (category)",
  )
  await ensureIndex(
    "finance_emails",
    "idx_finance_emails_queue",
    "KEY idx_finance_emails_queue (status, scheduled_at)",
  )

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

/** Build the {{variable}} map available to subject/body from a party row. */
function buildPartyVars(p: Record<string, any>): Record<string, string> {
  const val = (v: any) => (v == null ? "" : String(v))
  const name = val(p.customer_name || p.legal_name)
  return {
    party_name: name,
    customer_name: name,
    first_name: name.split(" ")[0] || "",
    party_id: val(p.party_id),
    legal_name: val(p.legal_name),
    contact_person: val(p.contact_person),
    email: val(p.official_email || p.invoice_email || p.alternate_email),
    gstin: val(p.gstin),
    pan: val(p.pan),
    party_type: val(p.party_type),
    mobile: val(p.mobile),
    city: val(p.city),
  }
}

/**
 * Resolve a customer/vendor (by numeric primary key) into a deliverable
 * recipient. Prefers the official email, then invoice, then alternate.
 */
export async function resolvePartyRecipient(
  partyId: number,
): Promise<ResolvedRecipient | null> {
  const rows = await query<any[]>(
    `SELECT id, party_id, customer_name, legal_name, party_type, party_category, gstin, pan,
            contact_person, official_email, invoice_email, alternate_email, mobile, city
     FROM customers_vendors WHERE id = ? LIMIT 1`,
    [partyId],
  )
  const p = rows[0]
  if (!p) return null
  const email = (p.official_email || p.invoice_email || p.alternate_email || "").trim()
  if (!isValidEmail(email)) return null
  return { email, name: p.customer_name || p.legal_name || null, vars: buildPartyVars(p) }
}

/** Deterministic idempotency key so an automated event never emails twice. */
export function buildDedupeKey(...parts: (string | number | null | undefined)[]): string {
  const basis = parts.map((p) => (p == null ? "" : String(p))).join("|")
  return crypto.createHash("sha1").update(basis).digest("hex")
}

// ---------------------------------------------------------------------------
// Create / send
// ---------------------------------------------------------------------------
export type CreateFinanceEmailInput = {
  partyId?: number | null
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
  scheduledAt?: string | null
  mode: "send" | "draft" | "schedule"
  createdBy?: string | number | null
  dedupeKey?: string | null
  attachment?: {
    pathname?: string | null
    filename?: string | null
    contentType?: string | null
    size?: number | null
  } | null
  /** When true, {{vars}} in subject/body are rendered from the party. */
  render?: boolean
}

export type CreateFinanceEmailResult =
  | { ok: true; id: number; emailUid: string; status: FinanceEmailStatus; deduped?: boolean }
  | { ok: false; error: string; code?: number }

function toMysqlDateTime(value: string | null | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 19).replace("T", " ")
}

async function generateEmailUid(): Promise<string> {
  const raw = await nextRecordId("FNE", { digits: 6 })
  const seq = raw.split("-")[1] ?? "000000"
  return `FNE-${new Date().getFullYear()}-${seq}`
}

/**
 * Create a finance email record and, for `mode: "send"`, dispatch it now.
 * Draft/schedule modes only persist the record for the dispatcher to pick up.
 */
export async function createFinanceEmail(
  input: CreateFinanceEmailInput,
): Promise<CreateFinanceEmailResult> {
  await ensureFinanceEmailHubSchema()

  const category = (input.category || "General").trim() || "General"
  const sourceModule = (input.sourceModule || "manual").trim() || "manual"
  const emailType = input.emailType || "Manual"

  let toEmail = (input.toEmail || "").trim()
  let toName = input.toName ?? null
  let vars: Record<string, string> = {}
  if (input.partyId) {
    const resolved = await resolvePartyRecipient(input.partyId)
    if (!resolved) {
      return { ok: false, error: "Selected customer/vendor has no valid email address", code: 400 }
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
  if (input.render !== false && input.partyId) {
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
      `SELECT id, email_uid, status FROM finance_emails
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

  const initialStatus: FinanceEmailStatus =
    input.mode === "draft" ? "Draft" : input.mode === "schedule" ? "Scheduled" : "Sending"

  const trackingToken = generateTrackingToken()
  const emailUid = await generateEmailUid()

  const result = await query<any>(
    `INSERT INTO finance_emails
      (email_uid, party_id, to_email, to_name, cc, bcc, template_id, subject, body,
       category, source_module, source_record_id, email_type, status, scheduled_at,
       thread_id, dedupe_key, attachment_pathname, attachment_name, attachment_type,
       attachment_size, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      emailUid,
      input.partyId || null,
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
      input.createdBy != null ? String(input.createdBy) : null,
    ],
  )
  const id = Number(result.insertId)

  if (input.mode !== "send") {
    return { ok: true, id, emailUid, status: initialStatus }
  }

  const sent = await sendFinanceEmailRow(id)
  if (sent.status === "Sent" && input.templateId) {
    const { recordTemplateUsage } = await import("@/lib/finance-email-templates")
    await recordTemplateUsage(input.templateId)
  }
  return { ok: true, id, emailUid, status: sent.status }
}

/**
 * Send (or retry) a single finance_emails row by id. Loads the stored content,
 * dispatches through the finance transport, and records the outcome. Uses the
 * row id as the tracking pixel token so /api/finance/emails/track/[id] works.
 */
export async function sendFinanceEmailRow(
  id: number,
): Promise<{ status: FinanceEmailStatus; error?: string }> {
  await ensureFinanceEmailHubSchema()

  const rows = await query<any[]>("SELECT * FROM finance_emails WHERE id = ? LIMIT 1", [id])
  const row = rows[0]
  if (!row) return { status: "Failed", error: "Email not found" }
  if (row.status === "Sent") return { status: "Sent" }
  if (row.status === "Cancelled") return { status: "Cancelled" }

  if (!isEmailConfigured("finance")) {
    await query("UPDATE finance_emails SET status='Failed', last_error=? WHERE id=?", [
      "Finance email transport is not configured",
      id,
    ])
    return { status: "Failed", error: "Finance email transport is not configured" }
  }

  await query("UPDATE finance_emails SET status='Sending' WHERE id=?", [id])

  const baseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
  const trackedBody = withTrackingPixel(row.body, baseUrl.replace(/\/$/, ""), String(id)).replace(
    `/api/track/${id}`,
    `/api/finance/emails/track/${id}`,
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
      department: "finance",
      attachments: attachments.length ? attachments : undefined,
    })
    await query(
      `UPDATE finance_emails
       SET status='Sent', message_id=?, attempts=attempts+1, last_error=NULL, sent_at=NOW()
       WHERE id=?`,
      [res.messageId || null, id],
    )
    return { status: "Sent" }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send email"
    const attempts = Number(row.attempts || 0) + 1
    const requeue = row.status === "Scheduled" || row.status === "Queued" || row.scheduled_at
    const nextStatus: FinanceEmailStatus =
      attempts >= MAX_SEND_ATTEMPTS ? "Failed" : requeue ? "Queued" : "Failed"
    await query("UPDATE finance_emails SET status=?, attempts=?, last_error=? WHERE id=?", [
      nextStatus,
      attempts,
      message.slice(0, 500),
      id,
    ])
    return { status: nextStatus, error: message }
  }
}

/**
 * Dispatch every finance email that is due: scheduled rows whose time has
 * arrived, plus queued retries. Idempotent — safe to call from a cron.
 */
export async function dispatchDueFinanceEmails(
  limit = 25,
): Promise<{ processed: number; sent: number; failed: number }> {
  await ensureFinanceEmailHubSchema()
  const due = await query<any[]>(
    `SELECT id FROM finance_emails
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
    const res = await sendFinanceEmailRow(Number(id))
    if (res.status === "Sent") sent++
    else if (res.status === "Failed") failed++
  }
  return { processed: due.length, sent, failed }
}
