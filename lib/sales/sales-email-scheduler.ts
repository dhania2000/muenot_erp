import { query } from "@/lib/db"
import {
  baseSubject,
  buildMessageId,
  buildNewThreadId,
  getLatestSuccessfulEmailByEmail,
  getLatestThreadByEmailId,
  hydrateDepartmentSMTP,
  isEmailConfigured,
  loadAttachment,
  sendEmail,
  withTrackingPixel,
  type LatestThread,
} from "@/lib/email"
import { attachLeadEvent } from "@/lib/sales/lead-lifecycle"

/**
 * Scheduled-send lifecycle for Sales emails. Mirrors the HR Email Hub
 * dispatcher (see lib/hr-email.ts): a composed email can be parked with a
 * future `scheduled_at`, and an unattended cron (see /api/cron/sales-emails)
 * sends every row whose time has arrived. Threading is resolved at DISPATCH
 * time — not schedule time — so a follow-up still lands in the recipient's
 * most recent conversation even if that conversation grew after scheduling.
 *
 * The immediate "send now" path stays entirely in app/api/sales/emails/route.ts;
 * this module only handles rows that were deliberately deferred.
 */

const MAX_SEND_ATTEMPTS = 5

// ---------------------------------------------------------------------------
// Self-healing schema so scheduling works even before the SQL migration runs.
// These columns are additive on top of the sales_emails table created by
// ensureEmailTables() in lib/email.ts.
// ---------------------------------------------------------------------------
let scheduleSchemaEnsured = false

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

export async function ensureSalesEmailScheduleSchema() {
  if (scheduleSchemaEnsured) return

  // Deferred-send bookkeeping columns.
  await ensureColumn("sales_emails", "scheduled_at", "DATETIME DEFAULT NULL")
  await ensureColumn("sales_emails", "attempts", "INT UNSIGNED NOT NULL DEFAULT 0")
  await ensureColumn("sales_emails", "last_error", "VARCHAR(500) DEFAULT NULL")
  await ensureColumn("sales_emails", "department", "VARCHAR(20) NOT NULL DEFAULT 'sales'")
  await ensureColumn("sales_emails", "attachment_pathname", "VARCHAR(255) DEFAULT NULL")
  await ensureColumn("sales_emails", "reply_to_email_id", "INT UNSIGNED DEFAULT NULL")

  // Expand the status ENUM to carry the full scheduled lifecycle. Safe to run
  // repeatedly; existing 'Sent'/'Failed'/'Opened' rows are unaffected.
  await query(
    `ALTER TABLE sales_emails MODIFY COLUMN status
     ENUM('Draft','Scheduled','Queued','Sending','Sent','Failed','Opened','Cancelled')
     NOT NULL DEFAULT 'Sent'`,
  )

  await ensureIndex("sales_emails", "idx_emails_queue", "INDEX idx_emails_queue (status, scheduled_at)")

  scheduleSchemaEnsured = true
}

/** Convert an ISO / datetime-local string into a MySQL DATETIME, or null. */
export function toMysqlDateTime(value: string | null | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 19).replace("T", " ")
}

function dispatchBaseUrl(): string {
  return (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "")
}

/**
 * Send (or retry) a single scheduled sales_emails row by id. Resolves the
 * conversation thread now, dispatches through the sales transport, and records
 * the outcome + attempt count. Follows the HR sendHrEmailRow contract:
 * terminal 'Failed' once retries are exhausted, otherwise re-queued.
 */
export async function sendScheduledSalesEmailRow(
  id: number,
): Promise<{ status: "Sent" | "Failed" | "Queued" | "Cancelled"; error?: string }> {
  await ensureSalesEmailScheduleSchema()

  const rows = await query<any[]>("SELECT * FROM sales_emails WHERE id = ? LIMIT 1", [id])
  const row = rows[0]
  if (!row) return { status: "Failed", error: "Email not found" }
  if (row.status === "Sent") return { status: "Sent" }
  if (row.status === "Cancelled") return { status: "Cancelled" }

  const department: "sales" | "hr" | "finance" =
    row.department === "hr" || row.department === "finance" ? row.department : "sales"

  if (!isEmailConfigured(department)) {
    await query("UPDATE sales_emails SET status='Failed', last_error=? WHERE id=?", [
      "Email transport is not configured",
      id,
    ])
    return { status: "Failed", error: "Email transport is not configured" }
  }

  await hydrateDepartmentSMTP(department)
  await query("UPDATE sales_emails SET status='Sending' WHERE id=?", [id])

  // Resolve the conversation the email joins, exactly as the immediate-send
  // route does — but at dispatch time so the thread is current.
  const mailType: "new" | "followup" = row.mail_type === "followup" ? "followup" : "new"
  const token: string = row.tracking_token
  let subject: string = row.subject
  let threadId: string = row.thread_id || buildNewThreadId(row.recipient_key || `addr:${row.to_email}`, token)
  let anchor: LatestThread | null = null

  if (mailType === "followup") {
    anchor = row.reply_to_email_id
      ? await getLatestThreadByEmailId(Number(row.reply_to_email_id))
      : await getLatestSuccessfulEmailByEmail(row.to_email)
    if (!anchor) {
      // A follow-up must never silently start a new conversation.
      await query("UPDATE sales_emails SET status='Failed', last_error=? WHERE id=?", [
        "No previous conversation to follow up on",
        id,
      ])
      return { status: "Failed", error: "No previous conversation to follow up on" }
    }
    threadId = anchor.threadId
    subject = `Re: ${baseSubject(anchor.rootSubject)}`
  }

  const references = anchor ? anchor.references : ""
  const inReplyTo = anchor ? anchor.messageId ?? "" : ""
  const entityRefId = threadId
  const messageId = buildMessageId(token, department)
  const htmlWithPixel = withTrackingPixel(row.body, dispatchBaseUrl(), token)
  const outgoingAttachment = await loadAttachment(row.attachment_pathname || null)

  let providerThreadId: string | null = anchor?.providerThreadId ?? null
  let effectiveMessageId = messageId

  try {
    const sendResult = await sendEmail({
      to: row.to_email,
      subject,
      html: htmlWithPixel,
      messageId,
      inReplyTo: inReplyTo || undefined,
      references: references || undefined,
      headers: { "X-Entity-Ref-ID": entityRefId },
      department,
      attachments: outgoingAttachment ? [outgoingAttachment] : undefined,
      providerThreadId: anchor?.providerThreadId ?? undefined,
    })
    providerThreadId = sendResult.providerThreadId ?? providerThreadId
    effectiveMessageId = sendResult.messageId ?? effectiveMessageId

    await query(
      `UPDATE sales_emails
       SET status='Sent', subject=?, message_id=?, in_reply_to=?, references_header=?,
           thread_id=?, provider_thread_id=?, attempts=attempts+1, last_error=NULL,
           error_message=NULL, sent_at=NOW()
       WHERE id=?`,
      [
        subject,
        effectiveMessageId,
        inReplyTo || null,
        [references, effectiveMessageId].filter(Boolean).join(" "),
        threadId,
        providerThreadId,
        id,
      ],
    )

    if (row.lead_id) {
      await attachLeadEvent({
        leadId: Number(row.lead_id),
        type: "email",
        title: `Email sent · ${subject}`,
        body: `To ${row.to_name || row.to_email}`,
        refType: "email",
        refId: id,
        actorId: row.sent_by || undefined,
        touchContact: true,
      }).catch(() => {})
    }

    return { status: "Sent" }
  } catch (error: any) {
    const parts = [
      error?.message,
      error?.code ? `code: ${error.code}` : null,
      error?.response ? `response: ${error.response}` : null,
    ].filter(Boolean)
    const message = (parts.length ? parts.join(" | ") : String(error)).slice(0, 500)
    const attempts = Number(row.attempts || 0) + 1
    const nextStatus: "Failed" | "Queued" = attempts >= MAX_SEND_ATTEMPTS ? "Failed" : "Queued"
    await query("UPDATE sales_emails SET status=?, attempts=?, last_error=?, error_message=? WHERE id=?", [
      nextStatus,
      attempts,
      message,
      message,
      id,
    ])
    return { status: nextStatus, error: message }
  }
}

/**
 * Dispatch every sales email that is due: scheduled rows whose time has
 * arrived, plus queued retries. Idempotent — safe to call from a cron on any
 * interval.
 */
export async function dispatchDueSalesEmails(
  limit = 25,
): Promise<{ processed: number; sent: number; failed: number }> {
  await ensureSalesEmailScheduleSchema()
  const due = await query<any[]>(
    `SELECT id FROM sales_emails
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
    const res = await sendScheduledSalesEmailRow(Number(id))
    if (res.status === "Sent") sent++
    else if (res.status === "Failed") failed++
  }
  return { processed: due.length, sent, failed }
}
