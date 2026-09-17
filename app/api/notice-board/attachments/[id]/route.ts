import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureNoticeSchema, canView, canManage, resolveEmployee, employeeCanSee } from "@/lib/notice-board"

export const dynamic = "force-dynamic"

// GET /api/notice-board/attachments/[id] — authorized download proxy.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canView(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const id = Number((await params).id)
  const att = (await query<any[]>(
    "SELECT id, notice_id, file_name, file_type, storage_url, uploaded_by FROM notice_attachments WHERE id = ? LIMIT 1",
    [id],
  ))[0]
  if (!att) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const manage = await canManage(session)
  if (!manage) {
    // Employees can only fetch files attached to a notice they can see.
    if (!att.notice_id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const emp = await resolveEmployee(session)
    if (!(await employeeCanSee(att.notice_id, emp)))
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const upstream = await fetch(att.storage_url)
  if (!upstream.ok || !upstream.body)
    return NextResponse.json({ error: "File unavailable" }, { status: 502 })

  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": att.file_type || "application/octet-stream",
      "Content-Disposition": `inline; filename="${encodeURIComponent(att.file_name)}"`,
      "Cache-Control": "private, no-store",
    },
  })
}
