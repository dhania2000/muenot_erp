import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureEmailTables } from "@/lib/email"

export async function GET() {
  const session = await requireFeature("sales.view_email_templates")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureEmailTables()
  const templates = await query(
    `SELECT t.*, u.name AS created_by_name
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
  const { name, subject, body: content, category } = body
  if (!name || !subject || !content) {
    return NextResponse.json({ error: "Name, subject, and body are required" }, { status: 400 })
  }

  const result = await query<any>(
    `INSERT INTO sales_email_templates (name, subject, body, category, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [name, subject, content, category || null, session.userId],
  )
  return NextResponse.json({ id: result.insertId })
}
