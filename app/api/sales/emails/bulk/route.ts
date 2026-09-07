import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import {
  buildMessageId,
  buildNewThreadId,
  buildRecipientKey,
  ensureEmailTables,
  generateTrackingToken,
  hydrateDepartmentSMTP,
  isEmailConfigured,
  loadAttachment,
  renderTemplate,
  resolveBaseUrl,
  sendEmail,
  withTrackingPixel,
} from "@/lib/email"

type IncomingRecipient = {
  lead_id?: number | string | null
  to_email?: string | null
  to_name?: string | null
}

type ResultRow = {
  to_email: string
  to_name: string | null
  status: "Sent" | "Failed"
  error?: string | null
}

/**
 * Bulk send: fires one independent, tracked email per recipient. Every message
 * starts its own fresh conversation (a blast, not a threaded follow-up) and is
 * personalized from the linked lead's fields via {{placeholders}}. Failures are
 * isolated per recipient so one bad address never aborts the whole batch.
 */
export async function POST(request: Request) {
  const session = await requireFeature("sales.send_emails")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEmailTables()

  const body = await request.json()
  const { template_id, subject, body: content, attachment } = body
  const recipients: IncomingRecipient[] = Array.isArray(body.recipients) ? body.recipients : []
  const department = "sales" as const
  await hydrateDepartmentSMTP(department)

  if (!subject || !content) {
    return NextResponse.json({ error: "Subject and body are required" }, { status: 400 })
  }
  if (recipients.length === 0) {
    return NextResponse.json({ error: "Select at least one recipient" }, { status: 400 })
  }
  if (recipients.length > 200) {
    return NextResponse.json({ error: "You can send to at most 200 recipients at once" }, { status: 400 })
  }
  if (!isEmailConfigured(department)) {
    return NextResponse.json(
      { error: "Email is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in your environment." },
      { status: 400 },
    )
  }

  // Resolve the shared attachment once — every recipient gets the same file.
  let attachmentPathname: string | null = attachment?.pathname || null
  if (!attachmentPathname && template_id) {
    const tplRows = await query<any[]>(
      `SELECT attachment_pathname FROM sales_email_templates WHERE id = ? LIMIT 1`,
      [template_id],
    )
    attachmentPathname = tplRows[0]?.attachment_pathname || null
  }
  const outgoingAttachment = await loadAttachment(attachmentPathname)
  const baseUrl = resolveBaseUrl(request)

  const results: ResultRow[] = []
  let sentCount = 0
  let failedCount = 0

  for (const r of recipients) {
    const leadId = r.lead_id ? Number(r.lead_id) : null
    let toEmail = (r.to_email || "").trim()
    let toName = (r.to_name || "").trim() || null

    // Fill recipient + personalization fields from the linked lead when present.
    let vars: Record<string, string | null> = {
      contact_person: toName,
      company_name: null,
      email: toEmail || null,
      company_email: null,
    }
    if (leadId) {
      const leadRows = await query<any[]>(
        `SELECT contact_person, company_name, email, company_email, designation, country
         FROM sales_leads WHERE id = ? LIMIT 1`,
        [leadId],
      )
      if (leadRows[0]) {
        vars = { ...vars, ...leadRows[0] }
        if (!toEmail) toEmail = (leadRows[0].email || "").trim()
        if (!toName) toName = leadRows[0].contact_person || null
      }
    }

    if (!toEmail) {
      results.push({ to_email: r.to_email || "(no address)", to_name: toName, status: "Failed", error: "Missing email address" })
      failedCount++
      continue
    }

    const token = generateTrackingToken()
    const messageId = buildMessageId(token)
    const recipientKey = buildRecipientKey(leadId, toEmail)
    const threadId = buildNewThreadId(recipientKey, token)

    const renderedSubject = renderTemplate(subject, vars)
    const renderedBody = renderTemplate(content, vars)
    const htmlWithPixel = withTrackingPixel(renderedBody, baseUrl, token)

    let status: "Sent" | "Failed" = "Sent"
    let errorMessage: string | null = null
    let providerThreadId: string | null = null
    try {
      const sendResult = await sendEmail({
        to: toEmail,
        subject: renderedSubject,
        html: htmlWithPixel,
        messageId,
        headers: { "X-Entity-Ref-ID": `${threadId}:${token}` },
        department,
        attachments: outgoingAttachment ? [outgoingAttachment] : undefined,
      })
      providerThreadId = sendResult.providerThreadId ?? null
    } catch (err: any) {
      status = "Failed"
      const parts = [
        err?.message,
        err?.code ? `code: ${err.code}` : null,
        err?.command ? `command: ${err.command}` : null,
        err?.response ? `response: ${err.response}` : null,
      ].filter(Boolean)
      errorMessage = (parts.length ? parts.join(" | ") : String(err)).slice(0, 500)
      console.error("[v0] Bulk email send failed:", { to: toEmail, code: err?.code, message: err?.message })
    }

    await query<any>(
      `INSERT INTO sales_emails
         (lead_id, template_id, to_email, to_name, subject, body, tracking_token,
          status, error_message, sent_by, message_id, in_reply_to, references_header, thread_id, recipient_key, provider_thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        leadId,
        template_id || null,
        toEmail,
        toName,
        renderedSubject,
        renderedBody,
        token,
        status,
        errorMessage,
        session.userId,
        messageId,
        null,
        messageId,
        threadId,
        recipientKey,
        providerThreadId,
      ],
    )

    results.push({ to_email: toEmail, to_name: toName, status, error: errorMessage })
    if (status === "Sent") sentCount++
    else failedCount++
  }

  return NextResponse.json({ sent: sentCount, failed: failedCount, total: recipients.length, results })
}
