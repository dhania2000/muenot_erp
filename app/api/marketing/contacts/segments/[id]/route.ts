import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureContactSchema } from "@/lib/marketing/contacts-db"

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json()
  const sets: string[] = []
  const args: any[] = []
  if (body.name !== undefined) {
    sets.push("name = ?")
    args.push(String(body.name).trim())
  }
  if (body.description !== undefined) {
    sets.push("description = ?")
    args.push(String(body.description).trim() || null)
  }
  if (body.color !== undefined) {
    sets.push("color = ?")
    args.push(body.color || null)
  }
  if (body.rules !== undefined) {
    sets.push("rules = ?")
    args.push(body.rules ? JSON.stringify(body.rules) : null)
  }
  if (sets.length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  await query(`UPDATE marketing_segments SET ${sets.join(", ")} WHERE id = ?`, [...args, Number(id)])
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const url = new URL(request.url)
  const contactId = url.searchParams.get("contactId")

  // Removing a single member vs. archiving the whole segment.
  if (contactId) {
    await query(`DELETE FROM marketing_segment_members WHERE segment_id = ? AND contact_id = ?`, [
      Number(id),
      Number(contactId),
    ])
    return NextResponse.json({ ok: true })
  }

  await query(`UPDATE marketing_segments SET archived_at = NOW() WHERE id = ?`, [Number(id)])
  return NextResponse.json({ ok: true })
}
