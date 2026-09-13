import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureEmailTables } from "@/lib/email"
import { TEMPLATE_STATUSES } from "@/lib/sales/email-template-engine"

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_email_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEmailTables()
  const { id } = await params
  const body = await request.json()

  const currentRows = await query<any[]>(`SELECT * FROM sales_email_templates WHERE id = ? LIMIT 1`, [id])
  const current = currentRows[0]
  if (!current) return NextResponse.json({ error: "Template not found" }, { status: 404 })

  // Status-only change (lifecycle action) — no version bump, just an audit snapshot.
  if (body.statusOnly) {
    if (!TEMPLATE_STATUSES.includes(body.status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 })
    }
    await query(`UPDATE sales_email_templates SET status = ? WHERE id = ?`, [body.status, id])
    await query(
      `INSERT INTO sales_email_template_versions
         (template_id, version, name, subject, body, category, description, status, change_note, edited_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        current.version,
        current.name,
        current.subject,
        current.body,
        current.category,
        current.description,
        body.status,
        `Status changed to ${body.status}`,
        session.userId,
      ],
    )
    return NextResponse.json({ ok: true })
  }

  const { name, subject, body: content, category, description, template_key, module, attachment } = body
  const status = TEMPLATE_STATUSES.includes(body.status) ? body.status : current.status
  if (!name || !subject || !content) {
    return NextResponse.json({ error: "Name, subject, and body are required" }, { status: 400 })
  }

  const contentChanged =
    name !== current.name ||
    subject !== current.subject ||
    content !== current.body ||
    (category || null) !== current.category ||
    (description || null) !== current.description
  const nextVersion = contentChanged ? Number(current.version) + 1 : Number(current.version)

  await query(
    `UPDATE sales_email_templates
       SET name = ?, subject = ?, body = ?, category = ?, description = ?, template_key = ?, module = ?, status = ?, version = ?,
           attachment_pathname = ?, attachment_name = ?, attachment_type = ?, attachment_size = ?
     WHERE id = ?`,
    [
      name,
      subject,
      content,
      category || null,
      description || null,
      template_key || null,
      module || null,
      status,
      nextVersion,
      attachment?.pathname || null,
      attachment?.filename || null,
      attachment?.contentType || null,
      attachment?.size || null,
      id,
    ],
  )

  if (contentChanged) {
    await query(
      `INSERT INTO sales_email_template_versions
         (template_id, version, name, subject, body, category, description, status, change_note, edited_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, nextVersion, name, subject, content, category || null, description || null, status, body.change_note || "Edited", session.userId],
    )
  }
  return NextResponse.json({ ok: true, version: nextVersion })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_email_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEmailTables()
  const { id } = await params
  await query(`DELETE FROM sales_email_templates WHERE id = ?`, [id])
  return NextResponse.json({ ok: true })
}
