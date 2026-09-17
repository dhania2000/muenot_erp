import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { ensureNoticeSchema, canView, resolveEmployee, employeeCanSee, markRead } from "@/lib/notice-board"

export const dynamic = "force-dynamic"

// POST /api/notice-board/[id]/read — mark the notice read for the current user.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canView(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const id = Number((await params).id)
  const emp = await resolveEmployee(session)
  if (!emp) return NextResponse.json({ ok: true, tracked: false })
  if (!(await employeeCanSee(id, emp)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await markRead(id, emp.id)
  return NextResponse.json({ ok: true, tracked: true })
}
