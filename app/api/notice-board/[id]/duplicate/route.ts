import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureNoticeSchema, canManage, assignNoticeCode, audit } from "@/lib/notice-board"

export const dynamic = "force-dynamic"

// POST /api/notice-board/[id]/duplicate — clone a notice into a new draft.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const id = Number((await params).id)
  const n = (await query<any[]>("SELECT * FROM notices WHERE id = ? LIMIT 1", [id]))[0]
  if (!n) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const res: any = await query(
    `INSERT INTO notices
      (heading, description, category, priority, status, to_type, audience_type, audience_config, include_inactive,
       department, start_date, end_date, publish_date, acknowledgement_required, notify_in_app, notify_email,
       pinned, keep_pinned_after_expiry, effective_date, review_date, created_by, created_by_name)
     VALUES (?,?,?,?, 'draft', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      `${n.heading} (copy)`, n.description, n.category, n.priority,
      n.to_type, n.audience_type, n.audience_config, n.include_inactive,
      n.department, n.start_date, n.end_date, null,
      n.acknowledgement_required, n.notify_in_app, n.notify_email,
      0, n.keep_pinned_after_expiry, n.effective_date, n.review_date,
      session.userId, session.name,
    ],
  )
  const newId = res.insertId as number
  await assignNoticeCode(newId)
  await audit(newId, session, "duplicated", `From ${n.notice_code || id}`)
  return NextResponse.json({ id: newId }, { status: 201 })
}
