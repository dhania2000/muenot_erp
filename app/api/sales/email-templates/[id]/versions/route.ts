import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureEmailTables } from "@/lib/email"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.view_email_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEmailTables()
  const { id } = await params
  const versions = await query(
    `SELECT v.id, v.version, v.name, v.subject, v.body, v.category, v.description, v.status,
            v.change_note, v.created_at, u.name AS edited_by_name
     FROM sales_email_template_versions v
     LEFT JOIN users u ON u.id = v.edited_by
     WHERE v.template_id = ?
     ORDER BY v.version DESC, v.id DESC`,
    [id],
  )
  return NextResponse.json({ versions })
}

/** Restore a prior version by writing its content forward as a new version. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_email_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEmailTables()
  const { id } = await params
  const { versionId } = await request.json()

  const snapRows = await query<any[]>(
    `SELECT * FROM sales_email_template_versions WHERE id = ? AND template_id = ? LIMIT 1`,
    [versionId, id],
  )
  const snap = snapRows[0]
  if (!snap) return NextResponse.json({ error: "Version not found" }, { status: 404 })

  const currentRows = await query<any[]>(`SELECT version FROM sales_email_templates WHERE id = ? LIMIT 1`, [id])
  if (!currentRows[0]) return NextResponse.json({ error: "Template not found" }, { status: 404 })
  const nextVersion = Number(currentRows[0].version) + 1

  await query(
    `UPDATE sales_email_templates
       SET name = ?, subject = ?, body = ?, category = ?, description = ?, version = ?
     WHERE id = ?`,
    [snap.name, snap.subject, snap.body, snap.category, snap.description, nextVersion, id],
  )
  await query(
    `INSERT INTO sales_email_template_versions
       (template_id, version, name, subject, body, category, description, status, change_note, edited_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      nextVersion,
      snap.name,
      snap.subject,
      snap.body,
      snap.category,
      snap.description,
      snap.status,
      `Restored from v${snap.version}`,
      session.userId,
    ],
  )
  return NextResponse.json({ ok: true, version: nextVersion })
}
