import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import {
  buildMessageId,
  buildRecruitThreadId,
  ensureRecruitEmailTables,
  getRecruitThreadContext,
  hydrateDepartmentSMTP,
  isEmailConfigured,
  loadAttachment,
  renderTemplate,
  sendEmail,
} from "@/lib/email"
import { recordCandidateActivity } from "@/lib/recruit-unification-db"

export async function GET() {
  const session = await requireFeature("recruitment.view_applications")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureRecruitEmailTables()
  const emails = await query<any[]>(
    `SELECT e.id, e.application_id, e.to_email, e.to_name, e.subject, e.status,
            e.error_message, e.sent_at, u.name AS sent_by_name
     FROM recruit_emails e
     LEFT JOIN users u ON u.id = e.sent_by
     ORDER BY e.sent_at DESC, e.id DESC
     LIMIT 500`,
  )
  return NextResponse.json({ emails, emailConfigured: isEmailConfigured("recruit") })
}

export async function POST(request: Request) {
  const session = await requireFeature("recruitment.view_applications")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureRecruitEmailTables()
  await hydrateDepartmentSMTP("recruit")

  const body = await request.json()
  const { application_id, template_id, to_email, to_name, subject, body: content, attachment } = body
  if (!to_email || !subject || !content) {
    return NextResponse.json({ error: "Recipient, subject, and body are required" }, { status: 400 })
  }
  if (!isEmailConfigured("recruit")) {
    return NextResponse.json(
      { error: "Email is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS in your environment." },
      { status: 400 },
    )
  }

  // Merge variables for template placeholders like {{candidate_name}} / {{job_title}}.
  let vars: Record<string, string | null | undefined> = { candidate_name: to_name || "", job_title: "", email: to_email }
  if (application_id) {
    const rows = await query<any[]>(
      `SELECT candidate_name, job_title, email FROM recruit_applications WHERE application_id = ? LIMIT 1`,
      [application_id],
    )
    if (rows[0]) vars = { ...vars, ...rows[0] }
  }
  const renderedSubject = renderTemplate(subject, vars)
  const renderedBody = renderTemplate(content, vars)

  let attachmentPathname: string | null = attachment?.pathname || null
  if (!attachmentPathname && template_id) {
    const tplRows = await query<any[]>(
      `SELECT attachment_pathname FROM recruit_email_templates WHERE id = ? LIMIT 1`,
      [template_id],
    )
    attachmentPathname = tplRows[0]?.attachment_pathname || null
  }
  const outgoing = await loadAttachment(attachmentPathname)

  // Phase 45: keep every email to this candidate/application in one conversation.
  const threadId = buildRecruitThreadId(application_id, to_email)
  const threadCtx = await getRecruitThreadContext(threadId)
  const messageId = buildMessageId("recruit", "recruit")
  const inReplyTo = threadCtx?.inReplyTo ?? null
  const references = threadCtx
    ? `${threadCtx.references} ${messageId}`.trim()
    : messageId

  let status: "Sent" | "Failed" = "Sent"
  let errorMessage: string | null = null
  try {
    await sendEmail({
      to: to_email,
      subject: renderedSubject,
      html: renderedBody,
      department: "recruit",
      attachments: outgoing ? [outgoing] : undefined,
      messageId,
      inReplyTo: inReplyTo ?? undefined,
      references,
      headers: { "X-Entity-Ref-ID": threadId },
    })
  } catch (err: any) {
    status = "Failed"
    const parts = [err?.message, err?.code ? `code: ${err.code}` : null, err?.command ? `command: ${err.command}` : null].filter(Boolean)
    errorMessage = (parts.length ? parts.join(" | ") : String(err)).slice(0, 500)
    console.error("[v0] Recruit email send failed:", { to: to_email, code: err?.code, message: err?.message })
  }

  const result = await query<any>(
    `INSERT INTO recruit_emails
       (application_id, template_id, to_email, to_name, subject, body, status, error_message, sent_by,
        message_id, in_reply_to, references_header, thread_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      application_id || null, template_id || null, to_email, to_name || null, renderedSubject, renderedBody,
      status, errorMessage, session.userId,
      messageId, inReplyTo, references, threadId,
    ],
  )

  if (status === "Failed") {
    return NextResponse.json({ error: errorMessage || "Failed to send email", id: result.insertId }, { status: 502 })
  }

  // Phase 44: surface the sent email on the ONE central candidate timeline so
  // the full communication history lives alongside every other activity.
  // Idempotent per email row; best-effort so it never blocks the response.
  try {
    await recordCandidateActivity({
      application_id: application_id || null,
      candidate_name: to_name || (vars.candidate_name as string) || null,
      job_applied: (vars.job_title as string) || null,
      email: to_email,
      activity_type: "Email",
      subject: renderedSubject,
      notes: `Email sent to ${to_email}`,
      outcome: "Sent",
      performed_by: session.name || null,
      source_type: "email",
      source_ref: String(result.insertId),
      created_by: session.userId,
    })
  } catch (e) {
    console.error("[recruit-email] timeline record failed", e)
  }

  return NextResponse.json({ id: result.insertId, status })
}
