import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { isEmailConfigured, sendEmail, withTrackingPixel } from "@/lib/email"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const rows = await query<any[]>("SELECT * FROM hr_emails ORDER BY sent_at DESC LIMIT 200")
  return NextResponse.json({ emails: rows })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json()
  const { employee_id, to_email, to_name, subject, body: content, template_id } = body
  if (!to_email || !subject || !content) return NextResponse.json({ error: "Recipient, subject and body are required" }, { status: 400 })
  if (!isEmailConfigured("hr")) return NextResponse.json({ error: "HR SMTP is not configured" }, { status: 400 })
  const trackingId = crypto.randomUUID()
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
    const trackedBody = withTrackingPixel(content, baseUrl, trackingId).replace(`/api/track/${trackingId}`, `/api/hr/emails/track/${trackingId}`)
  try {
    const result = await sendEmail({ to: to_email, subject, html: trackedBody, department: "hr" })
    await query("INSERT INTO hr_emails (employee_id,to_email,to_name,template_id,subject,body,status,message_id,thread_id) VALUES (?,?,?,?,?,?,?,?,?)", [employee_id || null, to_email, to_name || null, template_id || null, subject, content, "Sent", result.messageId || null, trackingId])
    return NextResponse.json({ ok: true, messageId: result.messageId })
  } catch (error) {
    await query("INSERT INTO hr_emails (employee_id,to_email,to_name,template_id,subject,body,status,thread_id) VALUES (?,?,?,?,?,?,?,?)", [employee_id || null, to_email, to_name || null, template_id || null, subject, content, "Failed", trackingId])
    return NextResponse.json({ error: "Unable to send email" }, { status: 500 })
  }
}
