import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureContactSchema, recordContactActivity } from "@/lib/marketing/contacts-db"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const activity = await query<any[]>(
    `SELECT a.*, u.name AS actor_name FROM marketing_contact_activity a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.contact_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
    [Number(id)],
  ).catch(() => [])
  return NextResponse.json({ activity })
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json()
  const summary = String(body.summary ?? "").trim()
  if (!summary) return NextResponse.json({ error: "A note is required" }, { status: 400 })

  await recordContactActivity({
    contactId: Number(id),
    type: body.type || "note",
    summary,
    actorId: session.userId,
  })
  await query(`UPDATE marketing_contacts SET last_activity_at = NOW() WHERE id = ?`, [Number(id)]).catch(() => {})
  return NextResponse.json({ ok: true }, { status: 201 })
}
