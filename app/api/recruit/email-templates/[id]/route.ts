import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureRecruitEmailTables } from "@/lib/email"

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("recruitment.view_applications")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureRecruitEmailTables()
  const { id } = await params
  const body = await request.json()
  const { name, subject, body: content, category, attachment } = body
  if (!name || !subject || !content) {
    return NextResponse.json({ error: "Name, subject, and body are required" }, { status: 400 })
  }

  await query(
    `UPDATE recruit_email_templates
       SET name = ?, subject = ?, body = ?, category = ?,
           attachment_pathname = ?, attachment_name = ?, attachment_type = ?, attachment_size = ?
     WHERE id = ?`,
    [
      name,
      subject,
      content,
      category || null,
      attachment?.pathname || null,
      attachment?.filename || null,
      attachment?.contentType || null,
      attachment?.size || null,
      id,
    ],
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("recruitment.view_applications")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureRecruitEmailTables()
  const { id } = await params
  await query(`DELETE FROM recruit_email_templates WHERE id = ?`, [id])
  return NextResponse.json({ ok: true })
}
