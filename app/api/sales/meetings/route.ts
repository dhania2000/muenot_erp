import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import {
  hydrateDepartmentSMTP,
  isEmailConfigured,
  sendEmail,
} from "@/lib/email"
import {
  buildICS,
  createMeetEvent,
  isGoogleCalendarConfigured,
  DEFAULT_TIME_ZONE,
} from "@/lib/google-calendar"

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
    googleConfigured: isGoogleCalendarConfigured(),
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
  if (createMeet) {
    if (!isGoogleCalendarConfigured()) {
      return NextResponse.json(
        { error: "Google Meet is not configured. Add the GOOGLE_* environment variables first." },
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

  if (createMeet) {
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
      const result = await createMeetEvent({
        summary: title,
        description: body.agenda || undefined,
        startDateTime,
        endDateTime,
        timeZone: DEFAULT_TIME_ZONE,
        attendees,
      })
      meetLink = result.meetLink
      googleEventId = result.eventId
    } catch (err: any) {
      console.error("[v0] Google Meet creation failed:", err?.message || err)
      return NextResponse.json(
        { error: "Could not create the Google Meet. Check the Google credentials and try again." },
        { status: 502 },
      )
    }

    // Send the branded invitation email with an .ics attachment to each attendee.
    await hydrateDepartmentSMTP("sales")
    if (isEmailConfigured("sales")) {
      const organizerEmail =
        process.env.GOOGLE_ORGANIZER_EMAIL ||
        (process.env.SALES_SMTP_FROM || process.env.SMTP_FROM || "sales@muenot.co.in")
          .match(/<([^>]+)>/)?.[1] ||
        process.env.SALES_SMTP_USER ||
        "sales@muenot.co.in"

      const ics = buildICS({
        uid: googleEventId || `${Date.now()}@muenot`,
        summary: title,
        description: [body.agenda, meetLink ? `Join: ${meetLink}` : ""].filter(Boolean).join("\n"),
        location: meetLink || undefined,
        start: startDate,
        end: endDate,
        organizerEmail,
        organizerName: "Muenot Business Team",
        attendees,
      })

      const when = startDate.toLocaleString("en-IN", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: DEFAULT_TIME_ZONE,
      })
      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.6;">
          <h2 style="margin:0 0 12px;">You're invited to a meeting</h2>
          <p style="margin:0 0 4px;"><strong>${title}</strong></p>
          <p style="margin:0 0 4px;">${when} (IST)</p>
          ${body.agenda ? `<p style="margin:12px 0;"><strong>Agenda:</strong> ${body.agenda}</p>` : ""}
          ${
            meetLink
              ? `<p style="margin:16px 0;">
                   <a href="${meetLink}" style="background:#1a73e8;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Join Google Meet</a>
                 </p>
                 <p style="margin:0 0 4px;color:#555;font-size:13px;">Or open: <a href="${meetLink}">${meetLink}</a></p>`
              : ""
          }
          <p style="margin:16px 0 0;color:#888;font-size:12px;">A calendar invitation is attached to this email.</p>
        </div>`

      try {
        await sendEmail({
          to: attendees.join(", "),
          subject: `Invitation: ${title}`,
          html,
          department: "sales",
          icalEvent: { method: "REQUEST", content: ics, filename: "invite.ics" },
        })
      } catch (err: any) {
        console.error("[v0] Meeting invite email failed:", err?.message || err)
        // The meeting + Meet link still exist; surface a soft warning instead of failing.
      }
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
