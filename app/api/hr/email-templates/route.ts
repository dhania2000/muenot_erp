import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json({ templates: await query<any[]>("SELECT * FROM hr_email_templates ORDER BY updated_at DESC") })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { name, subject, body, status = "Active", attachment } = await request.json()
  if (!name || !subject || !body) return NextResponse.json({ error: "Name, subject and body are required" }, { status: 400 })
  await query("INSERT INTO hr_email_templates (name,subject,body,status,attachment_pathname,attachment_name,attachment_type,attachment_size) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE subject=VALUES(subject),body=VALUES(body),status=VALUES(status),attachment_pathname=VALUES(attachment_pathname),attachment_name=VALUES(attachment_name),attachment_type=VALUES(attachment_type),attachment_size=VALUES(attachment_size)", [name, subject, body, status, attachment?.pathname || null, attachment?.filename || null, attachment?.contentType || null, attachment?.size || null])
  return NextResponse.json({ ok: true })
}
