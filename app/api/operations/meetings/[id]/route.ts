import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { ensureOperationsSchema } from "@/lib/operations-ensure"
import {
  getMeetingDetail,
  setMeetingStatus,
  saveMinutes,
  setFollowUp,
  type Actor,
} from "@/lib/operations-meeting-detail"

function actorFrom(session: any): Actor {
  return { id: session.userId ?? null, name: session.name ?? null }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()
  const { id } = await params
  const meeting = await getMeetingDetail(id)
  if (!meeting) return NextResponse.json({ error: "Meeting not found." }, { status: 404 })
  return NextResponse.json({ meeting })
}

/**
 * Head-level workflow updates: status transitions, minutes, and follow-up
 * scheduling. The sub-collections have their own routes.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const actor = actorFrom(session)

  let meeting: any = null
  if (body.action === "status") {
    if (!body.status) return NextResponse.json({ error: "Status is required." }, { status: 400 })
    meeting = await setMeetingStatus(id, body.status, actor)
  } else if (body.action === "minutes") {
    meeting = await saveMinutes(id, body.minutes ?? null, actor)
  } else if (body.action === "follow_up") {
    meeting = await setFollowUp(id, { follow_up_date: body.follow_up_date, follow_up_notes: body.follow_up_notes }, actor)
  } else {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 })
  }

  if (!meeting) return NextResponse.json({ error: "Meeting not found." }, { status: 404 })
  return NextResponse.json({ meeting })
}
