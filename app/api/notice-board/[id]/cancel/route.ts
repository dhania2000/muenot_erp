import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureNoticeSchema, canManage, audit } from "@/lib/notice-board"

export const dynamic = "force-dynamic"

// POST /api/notice-board/[id]/cancel — retract a published/scheduled notice.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const id = Number((await params).id)
  const notice = (await query<any[]>("SELECT id, status FROM notices WHERE id = ? LIMIT 1", [id]))[0]
  if (!notice) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!["published", "scheduled"].includes(notice.status))
    return NextResponse.json({ error: `Cannot cancel a ${notice.status} notice` }, { status: 409 })

  const body = await request.json().catch(() => ({}))
  const reason = String(body?.reason ?? "").trim().slice(0, 500) || null

  await query("UPDATE notices SET status = 'cancelled', cancel_reason = ?, pinned = 0 WHERE id = ?", [reason, id])
  await audit(id, session, "cancelled", reason ?? "No reason provided")
  return NextResponse.json({ id, status: "cancelled" })
}
