import "server-only"
import { query } from "@/lib/db"
import { getGoogleAccount } from "@/lib/google-accounts"
import {
  isGoogleOAuthConfigured,
  createMeetEventForUser,
  updateMeetEventForUser,
  cancelMeetEventForUser,
  GoogleEventGoneError,
} from "@/lib/google-calendar"

/**
 * Operations Meetings service (Phases 65-67).
 *
 * This is a THIN scheduling layer over the existing `operations_meetings` table
 * and the SAME per-user Google Calendar plumbing that Sales meetings use
 * (`sales_google_accounts` + `createMeetEventForUser` / `updateMeetEventForUser`
 * / `cancelMeetEventForUser`). It deliberately creates NO new calendar system:
 *
 *   • Create  → optionally inserts ONE Google event and stores its id/links.
 *   • Reschedule (PUT) → PATCHes the SAME stored google_event_id, never a new
 *     event, so calendars never accumulate duplicates.
 *   • Cancel   → deletes the stored event and marks the row Cancelled.
 *
 * Any Google failure is soft: the meeting row is still persisted so operations
 * scheduling never depends on Calendar being reachable.
 */

export const MEETING_TYPES = [
  "Project Meeting",
  "Client Meeting",
  "Review Meeting",
  "SLA Review",
  "Task Meeting",
] as const

export type MeetingType = (typeof MEETING_TYPES)[number]

export type MeetingFilters = {
  project_id?: string | null
  client_name?: string | null
  meeting_type?: string | null
  entity_type?: string | null
  entity_id?: string | null
  status?: string | null
  from?: string | null
  to?: string | null
}

export type MeetingInput = {
  title: string
  meeting_type?: string | null
  entity_type?: string | null
  entity_id?: string | null
  project_id?: string | null
  project_name?: string | null
  client_name?: string | null
  description?: string | null
  start_time: string
  end_time: string
  attendees?: string | null
  location?: string | null
  organizer_id?: number | null
  organizer_name?: string | null
  create_google_event?: boolean
  send_invites?: boolean
}

function splitEmails(raw: string | null | undefined): string[] {
  if (!raw) return []
  return Array.from(
    new Set(
      String(raw)
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)),
    ),
  )
}

// DATETIME columns want "YYYY-MM-DD HH:MM:SS"; the UI sends datetime-local
// ("YYYY-MM-DDTHH:MM"). Normalise both directions defensively.
function toSqlDateTime(value: string): string {
  const s = String(value).trim().replace("T", " ")
  // Ensure seconds are present.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return `${s}:00`
  return s
}

// Google wants RFC3339 without a trailing Z (we pass an explicit timeZone).
function toGoogleDateTime(value: string): string {
  const s = String(value).trim().replace(" ", "T")
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return `${s}:00`
  return s
}

export async function listMeetings(filters: MeetingFilters = {}): Promise<any[]> {
  const where: string[] = []
  const params: any[] = []
  if (filters.project_id) {
    where.push("project_id = ?")
    params.push(String(filters.project_id))
  }
  if (filters.client_name) {
    where.push("client_name = ?")
    params.push(String(filters.client_name))
  }
  if (filters.meeting_type) {
    where.push("meeting_type = ?")
    params.push(String(filters.meeting_type))
  }
  if (filters.entity_type) {
    where.push("entity_type = ?")
    params.push(String(filters.entity_type))
  }
  if (filters.entity_id) {
    where.push("entity_id = ?")
    params.push(String(filters.entity_id))
  }
  if (filters.status) {
    where.push("status = ?")
    params.push(String(filters.status))
  }
  if (filters.from) {
    where.push("start_time >= ?")
    params.push(toSqlDateTime(filters.from))
  }
  if (filters.to) {
    where.push("start_time <= ?")
    params.push(toSqlDateTime(filters.to))
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""
  return (await query(
    `SELECT * FROM operations_meetings ${clause} ORDER BY start_time DESC LIMIT 500`,
    params,
  ).catch(() => [])) as any[]
}

export type MeetingResult = { meeting: any; googleWarning: string | null }

export async function createMeeting(input: MeetingInput, actorId: number | null): Promise<MeetingResult> {
  const organizerId = input.organizer_id ?? actorId ?? null
  let googleEventId: string | null = null
  let meetLink: string | null = null
  let htmlLink: string | null = null
  let googleWarning: string | null = null

  if (input.create_google_event) {
    if (!isGoogleOAuthConfigured()) {
      googleWarning = "Google Calendar is not configured, so the meeting was saved without a calendar event."
    } else {
      const account = organizerId ? await getGoogleAccount(organizerId) : null
      if (!account) {
        googleWarning = "Organizer has not connected Google Calendar, so no calendar event was created."
      } else {
        try {
          const res = await createMeetEventForUser(account.refresh_token, {
            summary: input.title,
            description: input.description ?? undefined,
            startDateTime: toGoogleDateTime(input.start_time),
            endDateTime: toGoogleDateTime(input.end_time),
            attendees: splitEmails(input.attendees),
            sendInvites: input.send_invites !== false,
          })
          googleEventId = res.eventId
          meetLink = res.meetLink
          htmlLink = res.htmlLink
        } catch (error) {
          googleWarning = "Meeting saved, but the Google Calendar event could not be created."
          console.log("[v0] operations meeting google create failed:", (error as Error).message)
        }
      }
    }
  }

  const result = (await query(
    `INSERT INTO operations_meetings
       (title, meeting_type, entity_type, entity_id, project_id, project_name, client_name,
        description, start_time, end_time, attendees, organizer_id, organizer_name, location,
        google_event_id, meet_link, html_link, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.title,
      input.meeting_type ?? "Project Meeting",
      input.entity_type ?? null,
      input.entity_id ?? null,
      input.project_id ?? null,
      input.project_name ?? null,
      input.client_name ?? null,
      input.description ?? null,
      toSqlDateTime(input.start_time),
      toSqlDateTime(input.end_time),
      input.attendees ?? null,
      organizerId,
      input.organizer_name ?? null,
      input.location ?? null,
      googleEventId,
      meetLink,
      htmlLink,
      "Scheduled",
      actorId,
    ],
  )) as any
  const id = result?.insertId
  const rows = (await query(`SELECT * FROM operations_meetings WHERE id = ? LIMIT 1`, [id]).catch(() => [])) as any[]
  return { meeting: rows[0] ?? null, googleWarning }
}

async function getMeeting(id: string | number): Promise<any | null> {
  const rows = (await query(`SELECT * FROM operations_meetings WHERE id = ? LIMIT 1`, [id]).catch(() => [])) as any[]
  return rows[0] ?? null
}

export async function updateMeeting(
  id: string | number,
  input: Partial<MeetingInput>,
  actorId: number | null,
): Promise<MeetingResult> {
  const existing = await getMeeting(id)
  if (!existing) return { meeting: null, googleWarning: null }

  let googleWarning: string | null = null
  let meetLink = existing.meet_link
  let htmlLink = existing.html_link

  // Reschedule / edit the SAME Google event — never create a new one.
  if (existing.google_event_id) {
    const organizerId = input.organizer_id ?? existing.organizer_id ?? actorId ?? null
    const account = organizerId ? await getGoogleAccount(organizerId) : null
    if (account) {
      try {
        const res = await updateMeetEventForUser(account.refresh_token, existing.google_event_id, {
          summary: input.title ?? existing.title,
          description: input.description ?? existing.description ?? undefined,
          startDateTime: toGoogleDateTime(input.start_time ?? existing.start_time),
          endDateTime: toGoogleDateTime(input.end_time ?? existing.end_time),
          attendees: splitEmails(input.attendees ?? existing.attendees),
        })
        meetLink = res.meetLink ?? meetLink
        htmlLink = res.htmlLink ?? htmlLink
      } catch (error) {
        if (error instanceof GoogleEventGoneError) {
          googleWarning = "The linked Google event no longer exists; the meeting was updated locally only."
        } else {
          googleWarning = "Meeting updated, but the Google Calendar event could not be updated."
        }
        console.log("[v0] operations meeting google update failed:", (error as Error).message)
      }
    }
  }

  const fields: Record<string, any> = {
    title: input.title ?? existing.title,
    meeting_type: input.meeting_type ?? existing.meeting_type,
    entity_type: input.entity_type ?? existing.entity_type,
    entity_id: input.entity_id ?? existing.entity_id,
    project_id: input.project_id ?? existing.project_id,
    project_name: input.project_name ?? existing.project_name,
    client_name: input.client_name ?? existing.client_name,
    description: input.description ?? existing.description,
    start_time: toSqlDateTime(input.start_time ?? existing.start_time),
    end_time: toSqlDateTime(input.end_time ?? existing.end_time),
    attendees: input.attendees ?? existing.attendees,
    location: input.location ?? existing.location,
    organizer_name: input.organizer_name ?? existing.organizer_name,
    meet_link: meetLink,
    html_link: htmlLink,
  }
  const setCols = Object.keys(fields)
  await query(
    `UPDATE operations_meetings SET ${setCols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
    [...setCols.map((c) => fields[c]), id],
  )
  return { meeting: await getMeeting(id), googleWarning }
}

export async function cancelMeeting(id: string | number, actorId: number | null): Promise<MeetingResult> {
  const existing = await getMeeting(id)
  if (!existing) return { meeting: null, googleWarning: null }

  let googleWarning: string | null = null
  if (existing.google_event_id) {
    const organizerId = existing.organizer_id ?? actorId ?? null
    const account = organizerId ? await getGoogleAccount(organizerId) : null
    if (account) {
      try {
        await cancelMeetEventForUser(account.refresh_token, existing.google_event_id)
      } catch (error) {
        googleWarning = "Meeting cancelled, but the Google Calendar event could not be cancelled."
        console.log("[v0] operations meeting google cancel failed:", (error as Error).message)
      }
    }
  }
  await query(`UPDATE operations_meetings SET status = 'Cancelled' WHERE id = ?`, [id])
  return { meeting: await getMeeting(id), googleWarning }
}

export async function deleteMeeting(id: string | number, actorId: number | null): Promise<void> {
  // Cancel the linked event first so we never orphan a live calendar entry.
  await cancelMeeting(id, actorId).catch(() => null)
  await query(`DELETE FROM operations_meetings WHERE id = ?`, [id])
}
