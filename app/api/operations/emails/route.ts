import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { sendEmail, withTrackingPixel } from "@/lib/email"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json({ emails: await query<any[]>("SELECT * FROM operations_emails ORDER BY created_at DESC LIMIT 200") })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json()
  if (!body.to || !body.subject || !body.body) return NextResponse.json({ error: "Recipient, subject and body are required" }, { status: 400 })
  const result = await query<any>("INSERT INTO operations_emails (to_email, subject, body, status, created_by) VALUES (?, ?, ?, 'Queued', ?)", [body.to, body.subject, body.body, (session as any).user?.id ?? null])
  const id = result.insertId
  const html = withTrackingPixel(body.body, process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000", id).replace(`/api/track/${id}`, `/api/operations/emails/track/${id}`)
  try { await sendEmail({ to: body.to, subject: body.subject, html, department: "operations" }); await query("UPDATE operations_emails SET status='Sent', sent_at=NOW() WHERE id=?", [id]) } catch { await query("UPDATE operations_emails SET status='Failed' WHERE id=?", [id]); return NextResponse.json({ error: "Email send failed" }, { status: 500 }) }
  return NextResponse.json({ id, status: "Sent" }, { status: 201 })
}
