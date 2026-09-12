import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  getMeetingDetail,
  updateMeeting,
  archiveMeeting,
  MeetingNotFoundError,
  MeetingConflictError,
  MeetingValidationError,
} from "@/lib/sales/meeting-service"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.view_meetings")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const detail = await getMeetingDetail(Number(id))
  if (!detail) return NextResponse.json({ error: "Meeting not found" }, { status: 404 })
  return NextResponse.json(detail)
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_meetings")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json()

  try {
    const meeting = await updateMeeting(
      Number(id),
      {
        meeting_date: body.meeting_date,
        meeting_time: body.meeting_time,
        duration_minutes: body.duration_minutes != null ? Number(body.duration_minutes) : undefined,
        company_id: body.company_id,
        company_name: body.company_name,
        contact_id: body.contact_id,
        contact_person: body.contact_person,
        lead_id: body.lead_id,
        owner_id: body.owner_id,
        meeting_type: body.meeting_type,
        agenda: body.agenda,
        location: body.location,
        attendees: body.attendees,
        reminder_minutes: body.reminder_minutes,
        internal_notes: body.internal_notes,
        expectedRowVersion: body.row_version != null ? Number(body.row_version) : undefined,
      },
      session.userId,
    )
    return NextResponse.json({ meeting })
  } catch (error) {
    if (error instanceof MeetingConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    if (error instanceof MeetingNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    if (error instanceof MeetingValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    console.error("[v0] updateMeeting failed:", error)
    return NextResponse.json({ error: "Could not update the meeting." }, { status: 500 })
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_meetings")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  try {
    await archiveMeeting(Number(id), session.userId)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof MeetingNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    console.error("[v0] archiveMeeting failed:", error)
    return NextResponse.json({ error: "Could not archive the meeting." }, { status: 500 })
  }
}
