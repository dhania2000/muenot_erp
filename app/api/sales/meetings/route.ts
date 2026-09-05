import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import {
  createMeetEventForUser,
  isGoogleOAuthConfigured,
  DEFAULT_TIME_ZONE,
} from "@/lib/google-calendar"
import { getGoogleAccount } from "@/lib/google-accounts"

let columnsEnsured = false

/** Self-heal: add the Google Meet columns on existing installs. */
async function ensureMeetingColumns() {
  if (columnsEnsured) return
  for (const [column, definition] of [
    ["meet_link", "VARCHAR(500) DEFAULT NULL"],
    ["google_event_id", "VARCHAR(255) DEFAULT NULL"],
    ["attendees", "TEXT DEFAULT NULL"],
    ["duration_minutes", "INT UNSIGNED DEFAULT NULL"],
  ] as const) {
    const rows = await query<any[]>(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'sales_meetings' AND column_name = ? LIMIT 1`,
      [column],
    )
    if (rows.length === 0) {
      await query(`ALTER TABLE \`sales_meetings\` ADD COLUMN \`${column}\` ${definition}`)
    }
  }
  columnsEnsured = true
}

/** Parse a comma/newline/semicolon separated list of emails into a clean, unique array. */
function parseEmails(raw: unknown): string[] {
  if (!raw) return []
  const text = Array.isArray(raw) ? raw.join(",") : String(raw)
  const re = /[^\s,;]+@[^\s,;]+\.[^\s,;]+/g
  const found = text.match(re) || []
  return Array.from(new Set(found.map((e) => e.trim().toLowerCase())))
}

/** Normalise a time string to HH:MM:SS. */
function normalizeTime(time: string) {
  const parts = time.split(":")
  const hh = (parts[0] || "00").padStart(2, "0")
  const mm = (parts[1] || "00").padStart(2, "0")
  const ss = (parts[2] || "00").padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}

export async function GET() {
  const session = await requireFeature("sales.view_meetings")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureMeetingColumns()

  const meetings = await query(
    `SELECT m.*, u.name AS added_by_name
     FROM sales_meetings m
     LEFT JOIN users u ON u.id = m.added_by
     ORDER BY m.meeting_date DESC, m.meeting_time DESC`,
  )
  return NextResponse.json({
    meetings,
    googleConfigured: isGoogleOAuthConfigured(),
  })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_meetings")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await ensureMeetingColumns()

  const body = await request.json()
  if (!body.company_name || !body.meeting_date) {
    return NextResponse.json({ error: "Company name and date are required" }, { status: 400 })
  }

  const createMeet = Boolean(body.create_meet)
  const attendees = parseEmails(body.attendees)
  const durationMinutes = Math.max(5, Math.min(480, Number(body.duration_minutes) || 30))

  // Validate Meet prerequisites up front so we fail before inserting.
  let googleAccount: Awaited<ReturnType<typeof getGoogleAccount>> = null
  if (createMeet) {
    if (!isGoogleOAuthConfigured()) {
      return NextResponse.json(
        {
          error:
            "Google Meet is not configured. Add the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables first.",
        },
        { status: 400 },
      )
    }
    // The meeting is created in — and invitations are sent from — the signed-in
    // executive's own Google account, so it must be connected first.
    googleAccount = await getGoogleAccount(session.userId)
    if (!googleAccount) {
      return NextResponse.json(
        { error: "Connect your Google account first using the Connect Google button on the Meetings page." },
        { status: 400 },
      )
    }
    if (!body.meeting_time) {
      return NextResponse.json({ error: "Meeting time is required to create a Google Meet." }, { status: 400 })
    }
    if (attendees.length === 0) {
      return NextResponse.json({ error: "Add at least one attendee email to send invitations." }, { status: 400 })
    }
  }

  let meetLink: string | null = null
  let googleEventId: string | null = null

  if (createMeet && googleAccount) {
    const time = normalizeTime(body.meeting_time)
    // IST is a fixed +05:30 offset (no DST), so we can anchor the instant safely.
    const startDate = new Date(`${body.meeting_date}T${time}+05:30`)
    const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000)

    // Local wall-clock strings (IST) for the Calendar API's dateTime fields.
    const toISTWallClock = (d: Date) => {
      const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000)
      return ist.toISOString().slice(0, 19)
    }
    const startDateTime = toISTWallClock(startDate)
    const endDateTime = toISTWallClock(endDate)

    const title = `${body.meeting_type || "Meeting"} with ${body.company_name}`

    try {
      // Created in the executive's own calendar. sendInvites → sendUpdates: "all"
      // makes Google email a calendar invitation to every attendee directly
      // from the executive's account (no separate SMTP email needed).
      const result = await createMeetEventForUser(googleAccount.refresh_token, {
        summary: title,
        description: body.agenda || undefined,
        startDateTime,
        endDateTime,
        timeZone: DEFAULT_TIME_ZONE,
        attendees,
        sendInvites: true,
      })
      meetLink = result.meetLink
      googleEventId = result.eventId
    } catch (err: any) {
      console.error("[v0] Google Meet creation failed:", err?.message || err)
      return NextResponse.json(
        {
          error:
            "Could not create the Google Meet. Please reconnect your Google account from the Meetings page and try again.",
        },
        { status: 502 },
      )
    }
  }

  const [{ next }] = await query<{ next: number }[]>(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(meeting_code, 4) AS UNSIGNED)), 0) + 1 AS next FROM sales_meetings",
  )
  const meetingCode = `MM-${String(next).padStart(3, "0")}`

  const result = await query<any>(
    `INSERT INTO sales_meetings
     (meeting_code, meeting_date, meeting_time, company_name, contact_person, meeting_type,
      agenda, outcome_notes, next_steps, meet_link, google_event_id, attendees, duration_minutes, added_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      meetingCode,
      body.meeting_date,
      body.meeting_time || null,
      body.company_name,
      body.contact_person || null,
      body.meeting_type || "Discovery",
      body.agenda || null,
      body.outcome_notes || null,
      body.next_steps || null,
      meetLink,
      googleEventId,
      attendees.length ? attendees.join(", ") : null,
      createMeet ? durationMinutes : null,
      session.userId,
    ],
  )

  return NextResponse.json({
    id: result.insertId,
    meeting_code: meetingCode,
    meet_link: meetLink,
    invited: attendees.length,
  })
}
