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
  getLatestThreadId,
  getThreadContext,
  isEmailConfigured,
  loadAttachment,
  renderTemplate,
  resolveBaseUrl,
  sendEmail,
  withTrackingPixel,
  hydrateDepartmentSMTP,
} from "@/lib/email"

export async function GET() {
  const session = await requireFeature("sales.send_emails")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEmailTables()
  const emails = await query(
    `SELECT e.id, e.lead_id, e.to_email, e.to_name, e.subject, e.status,
            e.open_count, e.first_opened_at, e.last_opened_at, e.error_message,
            e.sent_at, e.thread_id, u.name AS sent_by_name, l.contact_person AS lead_contact
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
  // "new" starts a fresh conversation; "followup" continues the recipient's latest thread.
  const mailType = body.mail_type === "followup" ? "followup" : "new"
  const department = body.department === "hr" || body.department === "finance" ? body.department : "sales"
  await hydrateDepartmentSMTP(department)

  if (!to_email || !subject || !content) {
    return NextResponse.json({ error: "Recipient, subject, and body are required" }, { status: 400 })
  }
  if (!isEmailConfigured(department)) {
    return NextResponse.json(
      { error: "Email is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in your environment." },
      { status: 400 },
    )
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
  const messageId = buildMessageId(token)

  // Decide which conversation this email belongs to.
  // - New:       always a brand-new thread, even for a known recipient.
  // - Follow Up: continue the recipient's most recent thread; if they've never
  //              been emailed before, it naturally becomes a new thread.
  const recipientKey = buildRecipientKey(lead_id, to_email)
  let threadId: string
  let thread = null as Awaited<ReturnType<typeof getThreadContext>>
  if (mailType === "followup") {
    const latest = await getLatestThreadId(recipientKey)
    threadId = latest ?? buildNewThreadId(recipientKey, token)
    thread = latest ? await getThreadContext(latest) : null
  } else {
    threadId = buildNewThreadId(recipientKey, token)
  }

  let renderedSubject = renderTemplate(subject, vars)
  // If continuing a conversation, normalize the subject to "Re: <root subject>"
  // so mail clients reliably keep the follow-up in the same thread.
  if (thread) {
    renderedSubject = `Re: ${baseSubject(thread.rootSubject)}`
  }
  const renderedBody = renderTemplate(content, vars)
  const baseUrl = resolveBaseUrl(request)
  const htmlWithPixel = withTrackingPixel(renderedBody, baseUrl, token)

  // References chain = every prior message-id in the thread + nothing yet for this one.
  const references = thread ? thread.references : ""
  const inReplyTo = thread ? thread.inReplyTo : ""

  // X-Entity-Ref-ID controls how Gmail groups messages that share a subject line.
  // - New:       a unique value per email so Gmail (and Outlook) never merge it
  //              into an earlier same-subject conversation.
  // - Follow Up: the thread id, shared by every message in the thread, so the
  //              reply reliably groups with the last email sent to this recipient.
  const entityRefId = mailType === "followup" ? threadId : `${threadId}:${token}`

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
  try {
    await sendEmail({
      to: to_email,
      subject: renderedSubject,
      html: htmlWithPixel,
      messageId,
      inReplyTo: inReplyTo || undefined,
      references: references || undefined,
      headers: { "X-Entity-Ref-ID": entityRefId },
      department,
      attachments: outgoingAttachment ? [outgoingAttachment] : undefined,
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
        status, error_message, sent_by, message_id, in_reply_to, references_header, thread_id, recipient_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      messageId,
      inReplyTo || null,
      // Store the full references chain including this message so the next
      // follow-up can build on it.
      [references, messageId].filter(Boolean).join(" "),
      threadId,
      recipientKey,
    ],
  )

  if (status === "Failed") {
    return NextResponse.json({ error: errorMessage || "Failed to send email", id: result.insertId }, { status: 502 })
  }
  return NextResponse.json({ id: result.insertId, status, thread_id: threadId })
}
