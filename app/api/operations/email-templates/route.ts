import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const templates = await query<any[]>("SELECT * FROM operations_email_templates ORDER BY updated_at DESC, created_at DESC LIMIT 200")
  return NextResponse.json({ templates })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json()
  if (!body.name || !body.subject || !body.body) return NextResponse.json({ error: "Name, subject and body are required" }, { status: 400 })
  const result = await query<any>("INSERT INTO operations_email_templates (name, subject, body, attachment_pathname, attachment_name, attachment_type, attachment_size) VALUES (?, ?, ?, ?, ?, ?, ?)", [body.name, body.subject, body.body, body.attachment?.pathname || null, body.attachment?.filename || null, body.attachment?.contentType || null, body.attachment?.size || null])
  return NextResponse.json({ id: result.insertId }, { status: 201 })
}
