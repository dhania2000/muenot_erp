import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getGoogleAccount } from "@/lib/google-accounts"
import { isGoogleOAuthConfigured } from "@/lib/google-calendar"
import { ensureOperationsSchema } from "@/lib/operations-ensure"
import {
  listMeetings,
  createMeeting,
  updateMeeting,
  cancelMeeting,
  deleteMeeting,
  MEETING_TYPES,
} from "@/lib/operations-meetings"

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()

  const url = new URL(request.url)
  const meetings = await listMeetings({
    project_id: url.searchParams.get("project_id"),
    client_name: url.searchParams.get("client_name"),
    meeting_type: url.searchParams.get("meeting_type"),
    entity_type: url.searchParams.get("entity_type"),
    entity_id: url.searchParams.get("entity_id"),
    status: url.searchParams.get("status"),
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
  })
  const account = await getGoogleAccount(session.userId).catch(() => null)
  return NextResponse.json({
    meetings,
    meetingTypes: MEETING_TYPES,
    googleConfigured: isGoogleOAuthConfigured(),
    googleConnected: Boolean(account),
  })
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()

  const body = await request.json()
  if (!body.title || !body.start_time || !body.end_time) {
    return NextResponse.json({ error: "Title, start time and end time are required." }, { status: 400 })
  }
  const { meeting, googleWarning } = await createMeeting(
    {
      title: body.title,
      meeting_type: body.meeting_type ?? null,
      entity_type: body.entity_type ?? null,
      entity_id: body.entity_id ?? null,
      project_id: body.project_id ?? null,
      project_name: body.project_name ?? null,
      client_name: body.client_name ?? null,
      description: body.description ?? null,
      start_time: body.start_time,
      end_time: body.end_time,
      attendees: body.attendees ?? null,
      location: body.location ?? null,
      organizer_id: body.organizer_id ?? session.userId,
      organizer_name: body.organizer_name ?? session.name ?? null,
      create_google_event: Boolean(body.create_google_event),
      send_invites: body.send_invites,
    },
    session.userId,
  )
  return NextResponse.json({ meeting, warning: googleWarning })
}

export async function PUT(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()

  const body = await request.json()
  if (!body.id) return NextResponse.json({ error: "Meeting id is required." }, { status: 400 })
  const { meeting, googleWarning } = await updateMeeting(body.id, body, session.userId)
  if (!meeting) return NextResponse.json({ error: "Meeting not found." }, { status: 404 })
  return NextResponse.json({ meeting, warning: googleWarning })
}

export async function DELETE(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()

  const url = new URL(request.url)
  const id = url.searchParams.get("id")
  const action = url.searchParams.get("action")
  if (!id) return NextResponse.json({ error: "Meeting id is required." }, { status: 400 })

  if (action === "cancel") {
    const { meeting, googleWarning } = await cancelMeeting(id, session.userId)
    if (!meeting) return NextResponse.json({ error: "Meeting not found." }, { status: 404 })
    return NextResponse.json({ meeting, warning: googleWarning })
  }
  await deleteMeeting(id, session.userId)
  return NextResponse.json({ ok: true })
}
