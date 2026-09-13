import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureEmailTables } from "@/lib/email"
import { TEMPLATE_STATUSES, type TemplateStatus } from "@/lib/sales/email-template-engine"

export async function GET() {
  const session = await requireFeature("sales.view_email_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEmailTables()
  const templates = await query(
    `SELECT t.*, u.name AS created_by_name,
            (SELECT COUNT(*) FROM sales_emails e WHERE e.template_id = t.id) AS sent_count,
            (SELECT COUNT(*) FROM sales_emails e WHERE e.template_id = t.id AND e.open_count > 0) AS opened_count
     FROM sales_email_templates t
     LEFT JOIN users u ON u.id = t.created_by
     ORDER BY t.updated_at DESC`,
  )
  return NextResponse.json({ templates })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_email_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEmailTables()
  const body = await request.json()
  const { name, subject, body: content, category, description, template_key, module, attachment } = body
  const status: TemplateStatus = TEMPLATE_STATUSES.includes(body.status) ? body.status : "Active"
  if (!name || !subject || !content) {
    return NextResponse.json({ error: "Name, subject, and body are required" }, { status: 400 })
  }

  const result = await query<any>(
    `INSERT INTO sales_email_templates
       (name, subject, body, category, description, template_key, module, status, version,
        attachment_pathname, attachment_name, attachment_type, attachment_size, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      name,
      subject,
      content,
      category || null,
      description || null,
      template_key || null,
      module || null,
      status,
      attachment?.pathname || null,
      attachment?.filename || null,
      attachment?.contentType || null,
      attachment?.size || null,
      session.userId,
    ],
  )
  const id = result.insertId
  // First immutable snapshot.
  await query(
    `INSERT INTO sales_email_template_versions
       (template_id, version, name, subject, body, category, description, status, change_note, edited_by)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'Created', ?)`,
    [id, name, subject, content, category || null, description || null, status, session.userId],
  )
  return NextResponse.json({ id })
}
