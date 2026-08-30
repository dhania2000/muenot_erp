import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import {
  ensureEmailTables,
  generateTrackingToken,
  isEmailConfigured,
  renderTemplate,
  resolveBaseUrl,
  sendEmail,
  withTrackingPixel,
} from "@/lib/email"

export async function GET() {
  const session = await requireFeature("sales.send_emails")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEmailTables()
  const emails = await query(
    `SELECT e.id, e.lead_id, e.to_email, e.to_name, e.subject, e.status,
            e.open_count, e.first_opened_at, e.last_opened_at, e.error_message,
            e.sent_at, u.name AS sent_by_name, l.contact_person AS lead_contact
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
  const { lead_id, template_id, to_email, to_name, subject, body: content } = body

  if (!to_email || !subject || !content) {
    return NextResponse.json({ error: "Recipient, subject, and body are required" }, { status: 400 })
  }
  if (!isEmailConfigured()) {
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

  const renderedSubject = renderTemplate(subject, vars)
  const renderedBody = renderTemplate(content, vars)

  const token = generateTrackingToken()
  const baseUrl = resolveBaseUrl(request)
  const htmlWithPixel = withTrackingPixel(renderedBody, baseUrl, token)

  let status: "Sent" | "Failed" = "Sent"
  let errorMessage: string | null = null
  try {
    await sendEmail({ to: to_email, subject: renderedSubject, html: htmlWithPixel })
  } catch (err: any) {
    status = "Failed"
    errorMessage = String(err?.message || err).slice(0, 500)
  }

  const result = await query<any>(
    `INSERT INTO sales_emails
       (lead_id, template_id, to_email, to_name, subject, body, tracking_token, status, error_message, sent_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ],
  )

  if (status === "Failed") {
    return NextResponse.json({ error: errorMessage || "Failed to send email", id: result.insertId }, { status: 502 })
  }
  return NextResponse.json({ id: result.insertId, status })
}
