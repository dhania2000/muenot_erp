import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import {
  ensureNoticeSchema, canManage, materializeRecipients, dispatchNotice, audit,
  statusForPublish, normalizeAudienceValidated, parseAudienceConfig,
} from "@/lib/notice-board"

export const dynamic = "force-dynamic"

// POST /api/notice-board/[id]/publish — publish a draft or reschedule.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || !(await canManage(session)))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureNoticeSchema()

  const id = Number((await params).id)
  const notice = (await query<any[]>("SELECT * FROM notices WHERE id = ? LIMIT 1", [id]))[0]
  if (!notice) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!["draft", "scheduled"].includes(notice.status))
    return NextResponse.json({ error: `Cannot publish a ${notice.status} notice` }, { status: 409 })

  if (!String(notice.description ?? "").trim())
    return NextResponse.json({ error: "Notice details are required to publish" }, { status: 400 })

  const audErr = normalizeAudienceValidated(notice.to_type, notice.audience_type, parseAudienceConfig(notice.audience_config))
  if (audErr) return NextResponse.json({ error: audErr }, { status: 400 })

  const status = statusForPublish(notice.publish_date, notice.end_date)
  if (status === "expired")
    return NextResponse.json({ error: "The end date is in the past — update it before publishing" }, { status: 400 })

  await query(
    "UPDATE notices SET status = ?, published_at = ? WHERE id = ?",
    [status, status === "published" ? new Date() : null, id],
  )

  const refreshed = (await query<any[]>("SELECT * FROM notices WHERE id = ?", [id]))[0]
  await materializeRecipients(id, refreshed)
  await audit(id, session, status === "scheduled" ? "scheduled" : "published", `Status: ${status}`)

  let dispatch = null
  if (status === "published") dispatch = await dispatchNotice(id, new URL(request.url).origin)

  return NextResponse.json({ id, status, dispatch })
}
