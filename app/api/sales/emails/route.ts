import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import {
  baseSubject,
  buildMessageId,
  buildNewThreadId,
  buildRecipientKey,
  ensureEmailTables,
  generateTrackingToken,
  getLatestSuccessfulEmailByEmail,
  getLatestThreadByEmailId,
  isEmailConfigured,
  loadAttachment,
  resolveBaseUrl,
  sendEmail,
  withTrackingPixel,
  hydrateDepartmentSMTP,
  type LatestThread,
} from "@/lib/email"
import { renderEmailTemplate } from "@/lib/sales/email-template-engine"
import { attachLeadEvent } from "@/lib/sales/lead-lifecycle"

export async function GET() {
  const session = await requireFeature("sales.send_emails")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEmailTables()
  const emails = await query(
    `SELECT e.id, e.lead_id, e.to_email, e.to_name, e.subject, e.status,
            e.open_count, e.first_opened_at, e.last_opened_at, e.error_message,
            e.sent_at, e.thread_id, e.mail_type, u.name AS sent_by_name, l.contact_person AS lead_contact
     FROM sales_emails e
     LEFT JOIN users u ON u.id = e.sent_by
     LEFT JOIN sales_leads l ON l.id = e.lead_id
     ORDER BY e.sent_at DESC
     LIMIT 500`,
  )
  return NextResponse.json({ emails, emailConfigured: isEmailConfigured() })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.send_emails")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEmailTables()
  const body = await request.json()
  const { lead_id, template_id, to_email, to_name, subject, body: content, attachment } = body
  // Mail type is validated strictly: only the two known modes are accepted.
  // Anything else is rejected rather than silently coerced, so a tampered or
  // buggy client can never land in an undefined threading state.
  if (body.mail_type != null && body.mail_type !== "new" && body.mail_type !== "followup") {
    return NextResponse.json({ error: "Invalid mail type. Use 'new' or 'followup'." }, { status: 400 })
  }
  const mailType: "new" | "followup" = body.mail_type === "followup" ? "followup" : "new"
  // Optional: follow up from a SPECIFIC prior email (strongest, unambiguous path).
  // The client only supplies the id; the server loads the real thread metadata.
  const replyToEmailId = Number(body.reply_to_email_id) || null
  // Idempotency key de-duplicates double-clicks / retries. Fall back to a value
  // that still guards a single request when the client omits one.
  const idempotencyKey: string | null =
    typeof body.idempotency_key === "string" && body.idempotency_key.trim()
      ? body.idempotency_key.trim().slice(0, 80)
      : null
  const department = body.department === "hr" || body.department === "finance" ? body.department : "sales"
  await hydrateDepartmentSMTP(department)

  if (!to_email || !subject || !content) {
    return NextResponse.json({ error: "Recipient, subject, and body are required" }, { status: 400 })
  }
  // Reject obvious header-injection attempts in the recipient address.
  const normalizedTo = String(to_email).trim()
  if (/[\r\n,;]/.test(normalizedTo) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedTo)) {
    return NextResponse.json({ error: "Enter a single valid recipient email address." }, { status: 400 })
  }
  if (!isEmailConfigured(department)) {
    return NextResponse.json(
      { error: "Email is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in your environment." },
      { status: 400 },
    )
  }

  // Idempotency short-circuit: if this exact request already produced an email,
  // return it instead of sending again (double-click / retry protection).
  if (idempotencyKey) {
    const existing = await query<any[]>(
      `SELECT id, status, thread_id, provider_thread_id, message_id, mail_type
       FROM sales_emails WHERE idempotency_key = ? LIMIT 1`,
      [idempotencyKey],
    )
    if (existing[0]) {
      const e = existing[0]
      return NextResponse.json({
        id: e.id,
        status: e.status,
        mail_type: e.mail_type,
        thread_id: e.thread_id,
        provider_thread_id: e.provider_thread_id,
        message_id: e.message_id,
        deduped: true,
      })
    }
  }

  // Build template variables from the linked lead (if any).
  let vars: Record<string, string | null> = {
    contact_person: to_name || null,
    company_name: null,
    email: to_email,
    company_email: null,
  }
  if (lead_id) {
    const leadRows = await query<any[]>(
      `SELECT contact_person, company_name, email, company_email, designation, country
       FROM sales_leads WHERE id = ? LIMIT 1`,
      [lead_id],
    )
    if (leadRows[0]) vars = { ...vars, ...leadRows[0] }
  }

  const token = generateTrackingToken()
  const messageId = buildMessageId(token, department)

  // Decide which conversation this email belongs to.
  // - New:       always a brand-new thread, even for a known recipient.
  // - Follow Up: continue the recipient's most recent thread; if they've never
  //              been emailed before, it naturally becomes a new thread.
  const recipientKey = buildRecipientKey(lead_id, to_email)
  let threadId: string
  let anchor: LatestThread | null = null
  if (mailType === "followup") {
    // Resolve the anchor the follow-up must continue. Two trusted, server-side
    // paths — the client never chooses thread/message/provider ids directly:
    //   1. reply_to_email_id: follow up from a SPECIFIC prior email (strongest,
    //      unambiguous — used by "Follow Up" actions on an existing email/thread).
    //   2. otherwise: the recipient's MOST RECENT successful email, matched by
    //      email ADDRESS (not lead), ignoring failed sends.
    anchor = replyToEmailId
      ? await getLatestThreadByEmailId(replyToEmailId)
      : await getLatestSuccessfulEmailByEmail(to_email)

    // CRITICAL: a Follow Up must NEVER silently start a new conversation. When
    // there is no prior successful email to anchor on, block the send with a
    // clear 409 instead of downgrading to a new thread.
    if (!anchor) {
      console.log("[v0][thread] followup blocked — no anchor", { to: to_email, replyToEmailId })
      return NextResponse.json(
        {
          error: `No previous successfully sent conversation was found for ${normalizedTo}. Send a New email first.`,
          code: "NO_THREAD",
        },
        { status: 409 },
      )
    }
    threadId = anchor.threadId
  } else {
    // New: always a brand-new thread. No prior metadata is looked up or inherited.
    threadId = buildNewThreadId(recipientKey, token)
  }

  let renderedSubject = renderEmailTemplate(subject, vars)
  // On a follow-up the SERVER controls the thread subject: normalize to
  // "Re: <root subject>" so the conversation stays intact regardless of whatever
  // subject the composer submitted. baseSubject() strips existing "Re:" prefixes
  // so we never produce "Re: Re: Re:".
  if (anchor) {
    renderedSubject = `Re: ${baseSubject(anchor.rootSubject)}`
  }
  const thread = anchor

  console.log("[v0][thread] decision", {
    mailType,
    to: to_email,
    recipientKey,
    threadId,
    foundExistingThread: Boolean(thread),
    anchorEmailId: thread?.latestEmailId ?? null,
    thread_inReplyTo: thread?.messageId ?? null,
    thread_references: thread?.references ?? null,
    thread_rootSubject: thread?.rootSubject ?? null,
    thread_providerThreadId: thread?.providerThreadId ?? null,
    renderedSubject,
  })
  const renderedBody = renderEmailTemplate(content, vars)
  const baseUrl = resolveBaseUrl(request)
  const htmlWithPixel = withTrackingPixel(renderedBody, baseUrl, token)

  // Reply headers point at the anchor: In-Reply-To = the latest real Message-ID
  // in the thread; References = the full prior chain. Empty for a New email.
  const references = thread ? thread.references : ""
  const inReplyTo = thread ? thread.messageId ?? "" : ""

  // X-Entity-Ref-ID controls how Gmail groups messages that share a subject line:
  // Gmail will NOT merge two emails whose values differ, even when the
  // In-Reply-To / References headers and "Re:" subject say they belong together.
  // So every message in a conversation MUST carry the exact same value. The
  // thread id already satisfies both needs: a New email's thread id is unique
  // (recipient + token), so it never merges into an older same-subject thread,
  // and a Follow Up reuses the thread id of the email it continues, so Gmail
  // stacks it under the original. Do not append anything per-message here —
  // that is precisely what made follow-ups land in a separate thread.
  const entityRefId = threadId

  // Resolve the file to attach. An explicit attachment pathname from the
  // composer wins; otherwise fall back to the selected template's stored file.
  let attachmentPathname: string | null = attachment?.pathname || null
  if (!attachmentPathname && template_id) {
    const tplRows = await query<any[]>(
      `SELECT attachment_pathname FROM sales_email_templates WHERE id = ? LIMIT 1`,
      [template_id],
    )
    attachmentPathname = tplRows[0]?.attachment_pathname || null
  }
  const outgoingAttachment = await loadAttachment(attachmentPathname)

  let status: "Sent" | "Failed" = "Sent"
  let errorMessage: string | null = null
  // Carry the follow-up's Gmail conversation id forward, then overwrite it with
  // whatever the send returns so the very first email in a thread stores its own.
  let providerThreadId: string | null = thread?.providerThreadId ?? null
  // Start with our generated id; the send may return the REAL Message-ID that
  // Gmail stamped on the delivered message. Persisting the real one is what lets
  // the next follow-up build In-Reply-To / References the recipient can thread.
  let effectiveMessageId = messageId
  try {
    const sendResult = await sendEmail({
      to: to_email,
      subject: renderedSubject,
      html: htmlWithPixel,
      messageId,
      inReplyTo: inReplyTo || undefined,
      references: references || undefined,
      headers: { "X-Entity-Ref-ID": entityRefId },
      department,
      attachments: outgoingAttachment ? [outgoingAttachment] : undefined,
      // On a follow-up this is the original conversation's Gmail thread id, which
      // makes Gmail keep the reply in the same thread instead of starting a new one.
      providerThreadId: thread?.providerThreadId ?? undefined,
    })
    providerThreadId = sendResult.providerThreadId ?? providerThreadId
    effectiveMessageId = sendResult.messageId ?? effectiveMessageId
    console.log("[v0][thread] send ok", {
      mailType,
      to: to_email,
      passedProviderThreadId: thread?.providerThreadId ?? null,
      returnedProviderThreadId: sendResult.providerThreadId ?? null,
      generatedMessageId: messageId,
      effectiveMessageId,
      messageIdWasRewritten: messageId !== effectiveMessageId,
    })
  } catch (err: any) {
    status = "Failed"
    // Nodemailer/SMTP errors often carry the useful detail in `code` and
    // `response` rather than `message`. Build a message that never comes back
    // empty so the composer shows a real reason instead of a bare fallback.
    const parts = [
      err?.message,
      err?.code ? `code: ${err.code}` : null,
      err?.command ? `command: ${err.command}` : null,
      err?.response ? `response: ${err.response}` : null,
    ].filter(Boolean)
    errorMessage = (parts.length ? parts.join(" | ") : String(err)).slice(0, 500)
    console.error("[v0] Sales email send failed:", {
      department,
      to: to_email,
      code: err?.code,
      command: err?.command,
      response: err?.response,
      message: err?.message,
    })
  }

  const result = await query<any>(
    `INSERT INTO sales_emails
       (lead_id, template_id, to_email, to_name, subject, body, tracking_token,
        status, error_message, sent_by, message_id, in_reply_to, references_header,
        thread_id, recipient_key, provider_thread_id, mail_type, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      lead_id || null,
      template_id || null,
      to_email,
      to_name || null,
      renderedSubject,
      renderedBody,
      token,
      status,
      errorMessage,
      session.userId,
      effectiveMessageId,
      inReplyTo || null,
      // Store the full references chain including this message so the next
      // follow-up can build on it. Use the real (Gmail-assigned) id so the
      // recipient's mail client can match it.
      [references, effectiveMessageId].filter(Boolean).join(" "),
      threadId,
      recipientKey,
      // Gmail conversation id — reused by the next follow-up so it lands in the
      // same Gmail thread as this email.
      providerThreadId,
      // Explicit sender intent (audit/presentation) and the de-duplication key
      // that makes the idempotency short-circuit above actually work on retries.
      mailType,
      idempotencyKey,
    ],
  )

  if (lead_id && status !== "Failed") {
    await attachLeadEvent({
      leadId: Number(lead_id),
      type: "email",
      title: `Email sent · ${renderedSubject}`,
      body: `To ${to_name || to_email}`,
      refType: "email",
      refId: result.insertId,
      actorId: session.userId,
      touchContact: true,
    }).catch(() => {})
  }

  if (status === "Failed") {
    return NextResponse.json({ error: errorMessage || "Failed to send email", id: result.insertId }, { status: 502 })
  }
  return NextResponse.json({ id: result.insertId, status, mail_type: mailType, thread_id: threadId })
}
