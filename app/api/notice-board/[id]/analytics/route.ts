import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureNoticeSchema, canManage, getAnalytics, getRecipientStatus } from "@/lib/notice-board"

export const dynamic = "force-dynamic"

// GET /api/notice-board/[id]/analytics — read/ack breakdown (manager only).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const id = Number((await params).id)
  const notice = (await query<any[]>("SELECT id, heading, acknowledgement_required FROM notices WHERE id = ? LIMIT 1", [id]))[0]
  if (!notice) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const [summary, recipients] = await Promise.all([getAnalytics(id), getRecipientStatus(id)])
  return NextResponse.json({
    heading: notice.heading,
    acknowledgement_required: !!notice.acknowledgement_required,
    summary,
    recipients,
  })
}
