import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import {
  ensureRecruitEmailTables,
  hydrateDepartmentSMTP,
  isEmailConfigured,
  loadAttachment,
  renderTemplate,
  sendEmail,
} from "@/lib/email"

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

  let status: "Sent" | "Failed" = "Sent"
  let errorMessage: string | null = null
  try {
    await sendEmail({
      to: to_email,
      subject: renderedSubject,
      html: renderedBody,
      department: "recruit",
      attachments: outgoing ? [outgoing] : undefined,
    })
  } catch (err: any) {
    status = "Failed"
    const parts = [err?.message, err?.code ? `code: ${err.code}` : null, err?.command ? `command: ${err.command}` : null].filter(Boolean)
    errorMessage = (parts.length ? parts.join(" | ") : String(err)).slice(0, 500)
    console.error("[v0] Recruit email send failed:", { to: to_email, code: err?.code, message: err?.message })
  }

  const result = await query<any>(
    `INSERT INTO recruit_emails (application_id, template_id, to_email, to_name, subject, body, status, error_message, sent_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [application_id || null, template_id || null, to_email, to_name || null, renderedSubject, renderedBody, status, errorMessage, session.userId],
  )

  if (status === "Failed") {
    return NextResponse.json({ error: errorMessage || "Failed to send email", id: result.insertId }, { status: 502 })
  }
  return NextResponse.json({ id: result.insertId, status })
}
