import { google } from "googleapis"

/**
 * Google Meet scheduling helper.
 *
 * A real meet.google.com room can only be minted through the Google Calendar
 * API, so this module creates a Calendar event with an attached Meet
 * conference and returns the join link. We deliberately create the event with
 * `sendUpdates: "none"` — the ERP sends its own branded invitation email with
 * an .ics attachment, so we don't want Google to also email the attendees and
 * cause duplicate invites.
 *
 * Required environment variables (add in .env.local or the hosting panel):
 *   GOOGLE_CLIENT_ID      - OAuth 2.0 client id
 *   GOOGLE_CLIENT_SECRET  - OAuth 2.0 client secret
 *   GOOGLE_REFRESH_TOKEN  - refresh token for the organizer Google account
 *   GOOGLE_CALENDAR_ID    - optional, defaults to "primary"
 *   GOOGLE_ORGANIZER_EMAIL- optional, used as the .ics ORGANIZER address
 */

export const DEFAULT_TIME_ZONE = "Asia/Kolkata"

export function isGoogleCalendarConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN,
  )
}

function getOAuthClient() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  return oauth2
}

export type CreateMeetInput = {
  summary: string
  description?: string
  /** Local wall-clock start, e.g. "2026-09-10T14:30:00" (no offset). */
  startDateTime: string
  endDateTime: string
  timeZone?: string
  attendees: string[]
}

export type CreateMeetResult = {
  eventId: string | null
  meetLink: string | null
  htmlLink: string | null
}

export async function createMeetEvent(input: CreateMeetInput): Promise<CreateMeetResult> {
  const auth = getOAuthClient()
  const calendar = google.calendar({ version: "v3", auth })
  const timeZone = input.timeZone || DEFAULT_TIME_ZONE
  const requestId = `meet-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  const res = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
    conferenceDataVersion: 1,
    sendUpdates: "none",
    requestBody: {
      summary: input.summary,
      description: input.description,
      start: { dateTime: input.startDateTime, timeZone },
      end: { dateTime: input.endDateTime, timeZone },
      attendees: input.attendees.map((email) => ({ email })),
      conferenceData: {
        createRequest: {
          requestId,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
  })

  const data = res.data
  const meetLink =
    data.hangoutLink ||
    data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ||
    null

  return {
    eventId: data.id || null,
    meetLink,
    htmlLink: data.htmlLink || null,
  }
}

/** Format a Date as an iCalendar UTC timestamp: 20260910T090000Z */
function toICSDate(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
}

/** Escape iCalendar TEXT values per RFC 5545. */
function escapeICS(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n")
}

export type ICSInput = {
  uid: string
  summary: string
  description?: string
  location?: string
  start: Date
  end: Date
  organizerEmail: string
  organizerName?: string
  attendees: string[]
  method?: "REQUEST" | "CANCEL"
}

/** Build a minimal, standards-compliant VCALENDAR/VEVENT string. */
export function buildICS(input: ICSInput): string {
  const method = input.method || "REQUEST"
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Muenot ERP//Sales//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${input.uid}`,
    `DTSTAMP:${toICSDate(new Date())}`,
    `DTSTART:${toICSDate(input.start)}`,
    `DTEND:${toICSDate(input.end)}`,
    `SUMMARY:${escapeICS(input.summary)}`,
  ]
  if (input.description) lines.push(`DESCRIPTION:${escapeICS(input.description)}`)
  if (input.location) lines.push(`LOCATION:${escapeICS(input.location)}`)
  lines.push(
    `ORGANIZER;CN=${escapeICS(input.organizerName || input.organizerEmail)}:mailto:${input.organizerEmail}`,
  )
  for (const email of input.attendees) {
    lines.push(
      `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${email}`,
    )
  }
  lines.push("STATUS:CONFIRMED", "END:VEVENT", "END:VCALENDAR")
  return lines.join("\r\n")
}
