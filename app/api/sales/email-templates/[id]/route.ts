import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureEmailTables } from "@/lib/email"

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_email_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEmailTables()
  const { id } = await params
  const body = await request.json()
  const { name, subject, body: content, category, attachment } = body
  if (!name || !subject || !content) {
    return NextResponse.json({ error: "Name, subject, and body are required" }, { status: 400 })
  }

  await query(
    `UPDATE sales_email_templates
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
  const session = await requireFeature("sales.manage_email_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEmailTables()
  const { id } = await params
  await query(`DELETE FROM sales_email_templates WHERE id = ?`, [id])
  return NextResponse.json({ ok: true })
}
