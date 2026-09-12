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
  /** Popup reminder minutes-before; when set, overrides the calendar default. */
  reminderMinutes?: number | null
}

/** Build the Calendar reminders block from a minutes-before value. */
function buildReminders(reminderMinutes?: number | null) {
  if (reminderMinutes == null) return { useDefault: true }
  return {
    useDefault: false,
    overrides: [
      { method: "popup", minutes: reminderMinutes },
      { method: "email", minutes: reminderMinutes },
    ],
  }
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
      reminders: buildReminders(input.reminderMinutes),
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

/* -------------------------------------------------------------------------- */
/* Reading a user's own calendar (live sync into the ERP calendar module)     */
/* -------------------------------------------------------------------------- */

export type CalendarEvent = {
  id: string
  title: string
  /** ISO instant for timed events, or "YYYY-MM-DD" for all-day events. */
  start: string
  end: string | null
  allDay: boolean
  location: string | null
  description: string | null
  hangoutLink: string | null
  htmlLink: string | null
  status: string | null
}

/**
 * List events from a connected user's primary Google Calendar between two
 * instants. Uses the `calendar.events` scope already granted during the Meet
 * connect flow, so connecting once powers both meetings and the calendar.
 */
export async function listCalendarEventsForUser(
  refreshToken: string,
  opts: { timeMin: string; timeMax: string; timeZone?: string },
): Promise<CalendarEvent[]> {
  const auth = makeOAuthClient()
  auth.setCredentials({ refresh_token: refreshToken })
  const calendar = google.calendar({ version: "v3", auth })

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: opts.timeMin,
    timeMax: opts.timeMax,
    singleEvents: true, // expand recurring events into individual instances
    orderBy: "startTime",
    maxResults: 2500,
    timeZone: opts.timeZone || DEFAULT_TIME_ZONE,
  })

  const items = res.data.items || []
  return items
    .filter((e) => e.status !== "cancelled")
    .map((e) => ({
      id: e.id || "",
      title: e.summary || "(no title)",
      start: e.start?.dateTime || e.start?.date || "",
      end: e.end?.dateTime || e.end?.date || null,
      allDay: Boolean(e.start?.date),
      location: e.location || null,
      description: e.description || null,
      hangoutLink: e.hangoutLink || null,
      htmlLink: e.htmlLink || null,
      status: e.status || null,
    }))
    .filter((e) => e.start)
}

/* -------------------------------------------------------------------------- */
/* Per-user OAuth (each sales executive connects their own Google account)    */
/* -------------------------------------------------------------------------- */

/**
 * The OAuth scopes we request when a sales executive connects their account.
 * - calendar.events   → create the Meet-backed calendar event in their calendar
 * - openid / email    → read back which Google account was connected
 */
export const GOOGLE_MEET_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
]

/**
 * The app-level Google credentials only require a client id + secret. The
 * refresh token is now stored per user, so this is the check the per-user
 * flow uses (distinct from the legacy shared-account isGoogleCalendarConfigured).
 */
export function isGoogleOAuthConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
}

function makeOAuthClient(redirectUri?: string) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  )
}

/** Build the Google consent screen URL for the connect flow. */
export function buildGoogleAuthUrl(redirectUri: string, state: string) {
  const client = makeOAuthClient(redirectUri)
  return client.generateAuthUrl({
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force refresh_token to be returned every time
    include_granted_scopes: true,
    scope: GOOGLE_MEET_SCOPES,
    state,
  })
}

/** Exchange the authorization code for tokens and read the connected email. */
export async function exchangeGoogleCode(redirectUri: string, code: string) {
  const client = makeOAuthClient(redirectUri)
  const { tokens } = await client.getToken(code)

  let email: string | null = null
  if (tokens.id_token) {
    try {
      const payloadB64 = tokens.id_token.split(".")[1]
      const json = Buffer.from(payloadB64, "base64").toString("utf8")
      email = JSON.parse(json).email ?? null
    } catch {
      // id_token payload is informational only — ignore parse errors.
    }
  }

  return { tokens, email }
}

/**
 * Create a Meet-backed Calendar event in a specific executive's calendar using
 * their stored refresh token. `sendUpdates: "all"` makes Google email the
 * invitation to every attendee directly from the executive's own account.
 */
export async function createMeetEventForUser(
  refreshToken: string,
  input: CreateMeetInput & { sendInvites?: boolean },
): Promise<CreateMeetResult> {
  const auth = makeOAuthClient()
  auth.setCredentials({ refresh_token: refreshToken })
  const calendar = google.calendar({ version: "v3", auth })
  const timeZone = input.timeZone || DEFAULT_TIME_ZONE
  const requestId = `meet-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  const res = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    sendUpdates: input.sendInvites === false ? "none" : "all",
    requestBody: {
      summary: input.summary,
      description: input.description,
      start: { dateTime: input.startDateTime, timeZone },
      end: { dateTime: input.endDateTime, timeZone },
      attendees: input.attendees.map((email) => ({ email })),
      reminders: buildReminders(input.reminderMinutes),
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

/** Thrown when the referenced Google event no longer exists (404/410). */
export class GoogleEventGoneError extends Error {
  constructor(message = "The Google Calendar event no longer exists.") {
    super(message)
    this.name = "GoogleEventGoneError"
  }
}

function isGoneError(err: any): boolean {
  const code = err?.code ?? err?.response?.status
  return code === 404 || code === 410
}

/**
 * Patch an existing Calendar event in the organizer's calendar. Reuses the
 * stored google_event_id so we NEVER create a duplicate event on edit. When
 * attendees change, Google emails only the delta invitations.
 */
export async function updateMeetEventForUser(
  refreshToken: string,
  eventId: string,
  input: Partial<CreateMeetInput> & { sendUpdates?: boolean },
): Promise<CreateMeetResult> {
  const auth = makeOAuthClient()
  auth.setCredentials({ refresh_token: refreshToken })
  const calendar = google.calendar({ version: "v3", auth })
  const timeZone = input.timeZone || DEFAULT_TIME_ZONE

  const requestBody: Record<string, unknown> = {}
  if (input.summary !== undefined) requestBody.summary = input.summary
  if (input.description !== undefined) requestBody.description = input.description
  if (input.startDateTime) requestBody.start = { dateTime: input.startDateTime, timeZone }
  if (input.endDateTime) requestBody.end = { dateTime: input.endDateTime, timeZone }
  if (input.attendees) requestBody.attendees = input.attendees.map((email) => ({ email }))
  if (input.reminderMinutes !== undefined) requestBody.reminders = buildReminders(input.reminderMinutes)

  try {
    const res = await calendar.events.patch({
      calendarId: "primary",
      eventId,
      sendUpdates: input.sendUpdates === false ? "none" : "all",
      requestBody,
    })
    const data = res.data
    const meetLink =
      data.hangoutLink ||
      data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ||
      null
    return { eventId: data.id || eventId, meetLink, htmlLink: data.htmlLink || null }
  } catch (err) {
    if (isGoneError(err)) throw new GoogleEventGoneError()
    throw err
  }
}

/** Cancel (delete) a Calendar event, notifying attendees. Safe if already gone. */
export async function cancelMeetEventForUser(
  refreshToken: string,
  eventId: string,
  opts: { sendUpdates?: boolean } = {},
): Promise<void> {
  const auth = makeOAuthClient()
  auth.setCredentials({ refresh_token: refreshToken })
  const calendar = google.calendar({ version: "v3", auth })
  try {
    await calendar.events.delete({
      calendarId: "primary",
      eventId,
      sendUpdates: opts.sendUpdates === false ? "none" : "all",
    })
  } catch (err) {
    // Already deleted externally — the desired end state is reached.
    if (isGoneError(err)) return
    throw err
  }
}

/** Fetch a single event for reconciliation. Returns null when it no longer exists. */
export async function getMeetEventForUser(
  refreshToken: string,
  eventId: string,
): Promise<{ id: string; status: string | null; htmlLink: string | null; hangoutLink: string | null } | null> {
  const auth = makeOAuthClient()
  auth.setCredentials({ refresh_token: refreshToken })
  const calendar = google.calendar({ version: "v3", auth })
  try {
    const res = await calendar.events.get({ calendarId: "primary", eventId })
    const data = res.data
    return {
      id: data.id || eventId,
      status: data.status || null,
      htmlLink: data.htmlLink || null,
      hangoutLink: data.hangoutLink || null,
    }
  } catch (err) {
    if (isGoneError(err)) return null
    throw err
  }
}
