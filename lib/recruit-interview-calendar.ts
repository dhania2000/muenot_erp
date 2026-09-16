import "server-only"
import { query } from "@/lib/db"
import { getGoogleAccount } from "@/lib/google-accounts"
import {
  createMeetEventForUser,
  updateMeetEventForUser,
  cancelMeetEventForUser,
  GoogleEventGoneError,
  DEFAULT_TIME_ZONE,
} from "@/lib/google-calendar"
import { ensureLeadLifecycleSchema, notify } from "@/lib/sales/lead-lifecycle"

/**
 * PHASE 16 (Interview Calendar) + PHASE 17 (Interview Status) for the canonical
 * config-driven `recruitment_interviews` module.
 *
 * When an interview is created or rescheduled this module keeps a single Google
 * Calendar event in sync with the row and fans out candidate + interviewer
 * notifications. The Google event id is persisted on the row and reused on every
 * subsequent write, so a retry or an edit PATCHES the existing event instead of
 * creating a duplicate (the core PHASE 16/17 requirement).
 *
 * Everything here is best-effort: a calendar or notification failure is recorded
 * on the row (`google_sync_status` / `google_sync_error`) but never blocks the
 * underlying CRUD write.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DEFAULT_DURATION_MINUTES = 60

/** Scheduling-lifecycle statuses (PHASE 17). */
export const INTERVIEW_LIFECYCLE_STATUSES = [
  "Scheduled",
  "Confirmed",
  "Completed",
  "Rescheduled",
  "Cancelled",
  "No Show",
] as const
export type InterviewLifecycleStatus = (typeof INTERVIEW_LIFECYCLE_STATUSES)[number]

/** Statuses for which no live calendar event should exist. */
const CANCELLED_STATUSES = new Set<string>(["Cancelled"])
/** Statuses that represent an active, upcoming interview worth (re)syncing. */
const ACTIVE_STATUSES = new Set<string>(["Scheduled", "Confirmed", "Rescheduled"])

let schemaEnsured = false

/**
 * Idempotently add the calendar-sync system columns to `recruitment_interviews`.
 * Mirrors the pattern used by the sales meetings module. Safe to call repeatedly.
 */
export async function ensureInterviewCalendarSchema(): Promise<void> {
  if (schemaEnsured) return
  const alters = [
    "ALTER TABLE recruitment_interviews ADD COLUMN IF NOT EXISTS calendar_event_id VARCHAR(255) DEFAULT NULL",
    "ALTER TABLE recruitment_interviews ADD COLUMN IF NOT EXISTS meeting_link VARCHAR(500) DEFAULT NULL",
    "ALTER TABLE recruitment_interviews ADD COLUMN IF NOT EXISTS google_html_link VARCHAR(500) DEFAULT NULL",
    "ALTER TABLE recruitment_interviews ADD COLUMN IF NOT EXISTS google_organizer_id INT UNSIGNED DEFAULT NULL",
    "ALTER TABLE recruitment_interviews ADD COLUMN IF NOT EXISTS google_sync_status VARCHAR(40) DEFAULT NULL",
    "ALTER TABLE recruitment_interviews ADD COLUMN IF NOT EXISTS google_sync_error VARCHAR(500) DEFAULT NULL",
    "ALTER TABLE recruitment_interviews ADD COLUMN IF NOT EXISTS reschedule_count INT UNSIGNED NOT NULL DEFAULT 0",
    "ALTER TABLE recruitment_interviews ADD COLUMN IF NOT EXISTS candidate_email VARCHAR(190) DEFAULT NULL",
    "ALTER TABLE recruitment_interviews ADD COLUMN IF NOT EXISTS interviewer_email VARCHAR(190) DEFAULT NULL",
    "ALTER TABLE recruitment_interviews ADD COLUMN IF NOT EXISTS interview_status VARCHAR(40) DEFAULT NULL",
  ]
  for (const sql of alters) {
    try {
      await query(sql)
    } catch {
      // Column already exists / table not migrated yet / engine without IF NOT
      // EXISTS — all safe to ignore for this best-effort self-heal.
    }
  }
  schemaEnsured = true
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function cleanEmail(value: unknown): string | null {
  const email = String(value ?? "").trim().toLowerCase()
  return email && EMAIL_RE.test(email) ? email : null
}

/** Normalise a stored DATE value (string or Date) into "YYYY-MM-DD". */
function toDateString(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  }
  const s = String(value)
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

/** Parse a free-text time ("14:30", "2:30 PM", "9am") into "HH:MM" (24h). */
function toTimeString(value: unknown): string {
  const raw = String(value ?? "").trim()
  if (!raw) return "09:00"
  const m = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i)
  if (!m) return "09:00"
  let hh = Number(m[1])
  const mm = m[2] ? Number(m[2]) : 0
  const mer = (m[3] || "").toLowerCase()
  if (mer.startsWith("p") && hh < 12) hh += 12
  if (mer.startsWith("a") && hh === 12) hh = 0
  if (hh > 23 || mm > 59) return "09:00"
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(hh)}:${pad(mm)}`
}

function localStart(date: string, time: unknown): string {
  return `${date}T${toTimeString(time)}:00`
}

function localEnd(date: string, time: unknown, minutes: number): string {
  const start = new Date(localStart(date, time))
  const end = new Date(start.getTime() + minutes * 60_000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(
    end.getMinutes(),
  )}:00`
}

type InterviewRow = Record<string, any>

function eventSummary(row: InterviewRow): string {
  const round = row.interview_round ? ` — ${row.interview_round}` : ""
  const who = row.candidate_name || row.candidate_id || "Candidate"
  const job = row.job_applied ? ` (${row.job_applied})` : ""
  return `Interview: ${who}${job}${round}`
}

function eventDescription(row: InterviewRow): string {
  const lines = [
    row.interview_type ? `Type: ${row.interview_type}` : null,
    row.interview_mode ? `Mode: ${row.interview_mode}` : null,
    row.interviewer ? `Interviewer: ${row.interviewer}` : null,
    row.panel ? `Panel: ${row.panel}` : null,
    row.interview_link_location ? `Location / link: ${row.interview_link_location}` : null,
    row.interview_id ? `Reference: ${row.interview_id}` : null,
  ].filter(Boolean)
  return lines.join("\n")
}

function collectAttendees(row: InterviewRow): string[] {
  const seen = new Set<string>()
  for (const raw of [row.candidate_email, row.interviewer_email]) {
    const email = cleanEmail(raw)
    if (email) seen.add(email)
  }
  return [...seen]
}

/** Persist the sync outcome back onto the interview row (by business id). */
async function persist(interviewId: string, patch: Record<string, any>) {
  const cols = Object.keys(patch)
  if (!cols.length) return
  await query(
    `UPDATE recruitment_interviews SET ${cols.map((c) => `${c}=?`).join(", ")} WHERE interview_id = ?`,
    [...cols.map((c) => patch[c]), interviewId],
  )
}

/** Look up an internal user id from an email so the interviewer gets an in-app ping. */
async function userIdByEmail(email: string | null): Promise<number | null> {
  if (!email) return null
  try {
    const rows = (await query(
      "SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1",
      [email],
    )) as any[]
    return rows[0]?.id ?? null
  } catch {
    return null
  }
}

/** Fan out candidate + interviewer notifications (in-app + calendar email invites). */
async function sendNotifications(
  row: InterviewRow,
  actorId: number | null,
  kind: "scheduled" | "rescheduled" | "cancelled",
  hasCalendarInvite: boolean,
) {
  const candidateEmail = cleanEmail(row.candidate_email)
  const interviewerEmail = cleanEmail(row.interviewer_email)
  const when = [toDateString(row.interview_date), toTimeString(row.interview_time)].filter(Boolean).join(" ")
  const candidate = row.candidate_name || "the candidate"

  const verb =
    kind === "scheduled" ? "scheduled" : kind === "rescheduled" ? "rescheduled" : "cancelled"
  const title = `Interview ${verb}: ${candidate}`
  const body =
    kind === "cancelled"
      ? `The interview for ${candidate} has been cancelled.`
      : `Interview for ${candidate} ${verb} for ${when || "an upcoming date"}.`
  const link = "/modules/recruitment/interview-schedule"

  try {
    await ensureLeadLifecycleSchema()
  } catch {
    // notify() below is itself best-effort; continue regardless.
  }

  // Interviewer in-app notification when the interviewer is an internal user.
  const interviewerUserId = await userIdByEmail(interviewerEmail)
  const recipients = new Set<number>()
  if (interviewerUserId) recipients.add(interviewerUserId)
  if (actorId) recipients.add(actorId)
  for (const userId of recipients) {
    await notify(null, {
      userId,
      type: kind === "cancelled" ? "warning" : "info",
      title,
      body,
      link,
      entityType: "recruitment_interview",
      entityId: row.interview_id ?? null,
    })
  }

  // Record how the candidate / interviewer were notified over email. When Google
  // is connected the calendar invite IS the email notification (sendUpdates:all);
  // otherwise we mark it pending so a recruiter knows to reach out manually.
  const emailStatus = hasCalendarInvite
    ? candidateEmail || interviewerEmail
      ? `Calendar invite ${kind === "cancelled" ? "cancellation " : ""}sent`
      : "No attendee emails on file"
    : candidateEmail || interviewerEmail
      ? "Pending — calendar not connected"
      : "No attendee emails on file"
  await persist(row.interview_id, { email_status: emailStatus }).catch(() => {})
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

export type SyncInterviewInput = {
  /** The record as written (create) or the merged existing+body row (update). */
  record: InterviewRow
  /** The previous row state on an update, used to detect a reschedule. */
  existing?: InterviewRow | null
  actorId: number | null
  isUpdate: boolean
}

/**
 * Reconcile the interview's Google Calendar event + notifications after a
 * create/update. Reuses any stored `calendar_event_id` so retries and edits
 * never create a duplicate event.
 */
export async function syncInterviewCalendar(input: SyncInterviewInput): Promise<void> {
  await ensureInterviewCalendarSchema()

  const row = input.record
  const interviewId = row.interview_id
  if (!interviewId) return

  const status = String(row.interview_status || "").trim() || "Scheduled"
  const date = toDateString(row.interview_date)

  // Re-read the persisted event id (create path writes it into `record` late; on
  // update `existing` carries it) so we always PATCH rather than duplicate.
  const existingEventId: string | null =
    row.calendar_event_id || input.existing?.calendar_event_id || null
  const organizerId: number | null =
    row.google_organizer_id || input.existing?.google_organizer_id || input.actorId || null

  // Detect a reschedule: date or time changed on an update of an active interview.
  const scheduleChanged =
    input.isUpdate &&
    input.existing != null &&
    (toDateString(input.existing.interview_date) !== date ||
      toTimeString(input.existing.interview_time) !== toTimeString(row.interview_time))

  /* ----------------------------- Cancellation ---------------------------- */
  if (CANCELLED_STATUSES.has(status)) {
    if (existingEventId && organizerId) {
      const account = await getGoogleAccount(organizerId).catch(() => null)
      if (account?.refresh_token) {
        await cancelMeetEventForUser(account.refresh_token, existingEventId).catch(() => {})
      }
    }
    await persist(interviewId, {
      google_sync_status: existingEventId ? "Cancelled" : "Not Connected",
      google_sync_error: null,
    })
    await sendNotifications(row, input.actorId, "cancelled", Boolean(existingEventId)).catch(() => {})
    return
  }

  // Only sync active, dated interviews. Completed / No Show interviews keep their
  // historical event untouched.
  if (!ACTIVE_STATUSES.has(status) || !date) {
    return
  }

  const account = organizerId ? await getGoogleAccount(organizerId).catch(() => null) : null

  // No connected Google account → still keep the row's manual meeting link and
  // notify participants that scheduling happened.
  if (!account?.refresh_token) {
    await persist(interviewId, {
      google_sync_status: "Not Connected",
      meeting_link: row.meeting_link || row.interview_link_location || null,
    })
    await sendNotifications(row, input.actorId, scheduleChanged ? "rescheduled" : "scheduled", false).catch(
      () => {},
    )
    return
  }

  const summary = eventSummary(row)
  const description = eventDescription(row)
  const attendees = collectAttendees(row)
  const startDateTime = localStart(date, row.interview_time)
  const endDateTime = localEnd(date, row.interview_time, DEFAULT_DURATION_MINUTES)

  try {
    let eventId = existingEventId
    let meetLink: string | null = null
    let htmlLink: string | null = null

    if (existingEventId) {
      // Reuse the event — PATCH in place (no duplicate on retry/reschedule).
      try {
        const res = await updateMeetEventForUser(account.refresh_token, existingEventId, {
          summary,
          description,
          startDateTime,
          endDateTime,
          timeZone: DEFAULT_TIME_ZONE,
          attendees,
        })
        eventId = res.eventId
        meetLink = res.meetLink
        htmlLink = res.htmlLink
      } catch (err) {
        if (err instanceof GoogleEventGoneError) {
          // The event was deleted in Google — recreate a single fresh one.
          const res = await createMeetEventForUser(account.refresh_token, {
            summary,
            description,
            startDateTime,
            endDateTime,
            timeZone: DEFAULT_TIME_ZONE,
            attendees,
          })
          eventId = res.eventId
          meetLink = res.meetLink
          htmlLink = res.htmlLink
        } else {
          throw err
        }
      }
    } else {
      const res = await createMeetEventForUser(account.refresh_token, {
        summary,
        description,
        startDateTime,
        endDateTime,
        timeZone: DEFAULT_TIME_ZONE,
        attendees,
      })
      eventId = res.eventId
      meetLink = res.meetLink
      htmlLink = res.htmlLink
    }

    const patch: Record<string, any> = {
      calendar_event_id: eventId,
      google_html_link: htmlLink,
      google_organizer_id: organizerId,
      google_sync_status: "Synced",
      google_sync_error: null,
      meeting_link: meetLink || row.meeting_link || row.interview_link_location || null,
    }
    // A reschedule bumps the counter and reflects the lifecycle status, unless the
    // caller explicitly moved it to a terminal state.
    if (scheduleChanged) {
      const prevCount = Number(input.existing?.reschedule_count || 0)
      patch.reschedule_count = prevCount + 1
      if (status === "Scheduled" || status === "Confirmed") patch.interview_status = "Rescheduled"
    }
    await persist(interviewId, patch)
    await sendNotifications(row, input.actorId, scheduleChanged ? "rescheduled" : "scheduled", true).catch(
      () => {},
    )
  } catch (err: any) {
    await persist(interviewId, {
      google_sync_status: "Failed",
      google_sync_error: String(err?.message || err).slice(0, 480),
    })
    await sendNotifications(row, input.actorId, scheduleChanged ? "rescheduled" : "scheduled", false).catch(
      () => {},
    )
  }
}
