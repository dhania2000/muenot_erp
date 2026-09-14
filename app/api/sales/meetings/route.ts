import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { isGoogleOAuthConfigured } from "@/lib/google-calendar"
import { getGoogleAccount } from "@/lib/google-accounts"
import {
  listMeetings,
  createMeeting,
  MeetingValidationError,
  type MeetingListFilters,
} from "@/lib/sales/meeting-service"
import { canCreateInModule } from "@/lib/permission-enforce"

export async function GET(request: Request) {
  const session = await requireFeature("sales.view_meetings")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const sp = new URL(request.url).searchParams
  const filters: MeetingListFilters = {
    status: sp.get("status") || undefined,
    type: sp.get("type") || undefined,
    ownerId: sp.get("owner") ? Number(sp.get("owner")) : undefined,
    companyId: sp.get("company") ? Number(sp.get("company")) : undefined,
    leadId: sp.get("lead") ? Number(sp.get("lead")) : undefined,
    search: sp.get("search")?.trim() || undefined,
    from: sp.get("from") || undefined,
    to: sp.get("to") || undefined,
    scope: (sp.get("scope") as MeetingListFilters["scope"]) || undefined,
    includeArchived: sp.get("archived") === "1",
  }

  const [meetings, googleAccount] = await Promise.all([listMeetings(filters), getGoogleAccount(session.userId)])

  return NextResponse.json({
    meetings,
    googleConfigured: isGoogleOAuthConfigured(),
    googleConnected: Boolean(googleAccount),
  })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_meetings")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!(await canCreateInModule(session, "sales.meetings"))) {
    return NextResponse.json({ error: "You do not have permission to add meetings." }, { status: 403 })
  }

  const body = await request.json()
  if (!body.meeting_date) {
    return NextResponse.json({ error: "Meeting date is required" }, { status: 400 })
  }
  if (!body.company_id && !body.company_name && !body.lead_id) {
    return NextResponse.json({ error: "Select a company or lead for the meeting" }, { status: 400 })
  }

  // Guard the Google path up front so we fail before inserting anything.
  if (body.create_google_meet) {
    if (!isGoogleOAuthConfigured()) {
      return NextResponse.json(
        { error: "Google Meet is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first." },
        { status: 400 },
      )
    }
    const ownerId = body.owner_id ?? session.userId
    const account = await getGoogleAccount(ownerId)
    if (!account) {
      return NextResponse.json(
        { error: "Connect the organizer's Google account first using the Connect Google button." },
        { status: 400 },
      )
    }
    if (!body.meeting_time) {
      return NextResponse.json({ error: "Meeting time is required to create a Google Meet." }, { status: 400 })
    }
  }

  try {
    const meeting = await createMeeting(
      {
        meeting_date: body.meeting_date,
        meeting_time: body.meeting_time ?? null,
        duration_minutes: body.duration_minutes ? Number(body.duration_minutes) : 30,
        company_id: body.company_id ?? null,
        company_name: body.company_name ?? null,
        contact_id: body.contact_id ?? null,
        contact_person: body.contact_person ?? null,
        lead_id: body.lead_id ?? null,
        owner_id: body.owner_id ?? session.userId,
        meeting_type: body.meeting_type ?? "Discovery",
        agenda: body.agenda ?? null,
        location: body.location ?? null,
        attendees: body.attendees ?? null,
        reminder_minutes: body.reminder_minutes ?? null,
        internal_notes: body.internal_notes ?? null,
        create_google_meet: Boolean(body.create_google_meet),
      },
      session.userId,
    )
    // Surface a soft warning when the meeting saved but Google sync failed.
    const warning =
      meeting?.google_sync_status === "Failed"
        ? "Meeting saved, but the Google Calendar event could not be created. You can retry sync from the meeting."
        : null
    return NextResponse.json({ meeting, warning })
  } catch (error) {
    if (error instanceof MeetingValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    console.error("[v0] createMeeting failed:", error)
    return NextResponse.json({ error: "Could not create the meeting." }, { status: 500 })
  }
}
