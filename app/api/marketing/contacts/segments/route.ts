import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { nextRecordId } from "@/lib/record-ids"
import { ensureContactSchema } from "@/lib/marketing/contacts-db"

export async function GET() {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const segments = await query<any[]>(
    `SELECT s.*, COUNT(m.id) AS member_count, u.name AS created_by_name
       FROM marketing_segments s
       LEFT JOIN marketing_segment_members m ON m.segment_id = s.id
       LEFT JOIN users u ON u.id = s.created_by
      WHERE s.archived_at IS NULL
      GROUP BY s.id ORDER BY s.name`,
  ).catch(() => [])
  return NextResponse.json({ segments })
}

export async function POST(request: Request) {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  const name = String(body.name ?? "").trim()
  if (!name) return NextResponse.json({ error: "A segment name is required" }, { status: 400 })
  const type = body.type === "Dynamic" ? "Dynamic" : "Static"

  const code = await nextRecordId("SEG", { allowCustom: true, digits: 5 })
  const res = await query<any>(
    `INSERT INTO marketing_segments (segment_code, name, description, type, rules, color, created_by)
     VALUES (?,?,?,?,?,?,?)`,
    [
      code,
      name,
      String(body.description ?? "").trim() || null,
      type,
      body.rules ? JSON.stringify(body.rules) : null,
      body.color || null,
      session.userId,
    ],
  )
  const segmentId = Number((res as any).insertId)

  // A static segment can be seeded from a set of contact ids.
  if (type === "Static" && Array.isArray(body.contactIds)) {
    for (const id of body.contactIds.map(Number).filter(Boolean)) {
      await query(
        `INSERT IGNORE INTO marketing_segment_members (segment_id, contact_id, added_by) VALUES (?,?,?)`,
        [segmentId, id, session.userId],
      ).catch(() => {})
    }
  }

  return NextResponse.json({ ok: true, id: segmentId, segment_code: code }, { status: 201 })
}
