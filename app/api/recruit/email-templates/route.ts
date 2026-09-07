import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureRecruitEmailTables } from "@/lib/email"

export async function GET() {
  const session = await requireFeature("recruitment.view_applications")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureRecruitEmailTables()
  const templates = await query<any[]>(
    `SELECT t.id, t.name, t.subject, t.body, t.category,
            t.attachment_pathname, t.attachment_name, t.attachment_type, t.attachment_size,
            t.created_at, t.updated_at, u.name AS created_by_name
     FROM recruit_email_templates t
     LEFT JOIN users u ON u.id = t.created_by
     ORDER BY t.updated_at DESC`,
  )
  return NextResponse.json({ templates })
}

export async function POST(request: Request) {
  const session = await requireFeature("recruitment.view_applications")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureRecruitEmailTables()
  const body = await request.json()
  const { name, subject, body: content, category, attachment } = body
  if (!name || !subject || !content) {
    return NextResponse.json({ error: "Name, subject, and body are required" }, { status: 400 })
  }

  const result = await query<any>(
    `INSERT INTO recruit_email_templates
       (name, subject, body, category, attachment_pathname, attachment_name, attachment_type, attachment_size, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      subject,
      content,
      category || null,
      attachment?.pathname || null,
      attachment?.filename || null,
      attachment?.contentType || null,
      attachment?.size || null,
      session.userId,
    ],
  )
  return NextResponse.json({ id: result.insertId })
}
