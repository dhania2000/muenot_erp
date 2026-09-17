import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureNoticeSchema, canManage, audit } from "@/lib/notice-board"

export const dynamic = "force-dynamic"

// POST /api/notice-board/[id]/archive — archive or restore to draft.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const id = Number((await params).id)
  const notice = (await query<any[]>("SELECT id, status FROM notices WHERE id = ? LIMIT 1", [id]))[0]
  if (!notice) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await request.json().catch(() => ({}))
  const restore = body?.restore === true

  if (restore) {
    if (notice.status !== "archived")
      return NextResponse.json({ error: "Only archived notices can be restored" }, { status: 409 })
    await query("UPDATE notices SET status = 'draft' WHERE id = ?", [id])
    await audit(id, session, "restored", "Restored to draft")
    return NextResponse.json({ id, status: "draft" })
  }

  if (notice.status === "archived")
    return NextResponse.json({ error: "Already archived" }, { status: 409 })
  await query("UPDATE notices SET status = 'archived', pinned = 0 WHERE id = ?", [id])
  await audit(id, session, "archived", `From ${notice.status}`)
  return NextResponse.json({ id, status: "archived" })
}
