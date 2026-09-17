import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureNoticeSchema, canView, resolveEmployee, employeeCanSee, markRead, acknowledge } from "@/lib/notice-board"

export const dynamic = "force-dynamic"

// POST /api/notice-board/[id]/acknowledge — record acknowledgement (implies read).
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canView(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const id = Number((await params).id)
  const notice = (await query<any[]>("SELECT acknowledgement_required FROM notices WHERE id = ? LIMIT 1", [id]))[0]
  if (!notice) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const emp = await resolveEmployee(session)
  if (!emp) return NextResponse.json({ error: "No employee record linked to your account" }, { status: 400 })
  if (!(await employeeCanSee(id, emp)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await markRead(id, emp.id)
  await acknowledge(id, emp.id)
  return NextResponse.json({ ok: true })
}
