import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  completeMeeting,
  cancelMeeting,
  rescheduleMeeting,
  markNoShow,
  recreateGoogleEvent,
  MeetingNotFoundError,
  MeetingValidationError,
} from "@/lib/sales/meeting-service"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_meetings")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const meetingId = Number(id)
  const body = await request.json().catch(() => ({}))
  const action = String(body.action || "")

  try {
    let meeting
    switch (action) {
      case "complete":
        meeting = await completeMeeting(
          meetingId,
          {
            outcome: body.outcome ?? null,
            outcome_notes: body.outcome_notes ?? null,
            next_steps: body.next_steps ?? null,
            create_follow_up: Boolean(body.create_follow_up),
            follow_up_at: body.follow_up_at ?? null,
            follow_up_channel: body.follow_up_channel ?? null,
            follow_up_purpose: body.follow_up_purpose ?? null,
          },
          session.userId,
        )
        break
      case "cancel":
        meeting = await cancelMeeting(meetingId, { reason: body.reason ?? null }, session.userId)
        break
      case "reschedule":
        meeting = await rescheduleMeeting(
          meetingId,
          {
            meeting_date: body.meeting_date,
            meeting_time: body.meeting_time ?? null,
            duration_minutes: body.duration_minutes != null ? Number(body.duration_minutes) : null,
            reason: body.reason ?? null,
          },
          session.userId,
        )
        break
      case "no_show":
        meeting = await markNoShow(meetingId, session.userId)
        break
      case "sync_google":
        meeting = await recreateGoogleEvent(meetingId, session.userId)
        break
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 })
    }
    return NextResponse.json({ meeting })
  } catch (error) {
    if (error instanceof MeetingNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    if (error instanceof MeetingValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    console.error(`[v0] meeting action '${action}' failed:`, error)
    return NextResponse.json({ error: "Could not complete the action." }, { status: 500 })
  }
}
