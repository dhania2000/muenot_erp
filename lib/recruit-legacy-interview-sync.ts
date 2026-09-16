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
import { resolveEmployeeRef } from "@/lib/recruit-employee-resolve"

/**
 * Phase 57 — Calendar + notification sync for the LEGACY `recruit_interviews`
 * table.
 *
 * The canonical config-driven `recruitment_interviews` module already keeps a
 * single Google Calendar event in step with each interview and fans out
 * candidate + interviewer notifications (see `recruit-interview-calendar.ts`).
 * The older `recruit_interviews` records (created / edited through
 * `/api/recruit/interviews`) had NO such sync: cancelling or rescheduling one
 * left a stale calendar invite live and nobody was notified.
 *
 * This module gives the legacy table the same treatment, adapted to its schema
 * (`scheduled_at` DATETIME, free-text `interviewer`, `location`, `status`). It
 * reuses any stored `calendar_event_id` so a reschedule PATCHES the existing
 * event instead of creating a duplicate. Everything is best-effort: a calendar
 * or notification failure is recorded on the row but never blocks the CRUD
 * write that triggered it.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DEFAULT_DURATION_MINUTES = 60

let schemaEnsured = false

/** Idempotently add the calendar-sync system columns to `recruit_interviews`. */
export async function ensureLegacyInterviewSyncSchema(): Promise<void> {
  if (schemaEnsured) return
  const alters = [
    "ALTER TABLE recruit_interviews ADD COLUMN IF NOT EXISTS calendar_event_id VARCHAR(255) DEFAULT NULL",
    "ALTER TABLE recruit_interviews ADD COLUMN IF NOT EXISTS google_html_link VARCHAR(500) DEFAULT NULL",
    "ALTER TABLE recruit_interviews ADD COLUMN IF NOT EXISTS meeting_link VARCHAR(500) DEFAULT NULL",
    "ALTER TABLE recruit_interviews ADD COLUMN IF NOT EXISTS google_organizer_id INT UNSIGNED DEFAULT NULL",
    "ALTER TABLE recruit_interviews ADD COLUMN IF NOT EXISTS google_sync_status VARCHAR(40) DEFAULT NULL",
    "ALTER TABLE recruit_interviews ADD COLUMN IF NOT EXISTS google_sync_error VARCHAR(500) DEFAULT NULL",
    "ALTER TABLE recruit_interviews ADD COLUMN IF NOT EXISTS reschedule_count INT UNSIGNED NOT NULL DEFAULT 0",
    "ALTER TABLE recruit_interviews ADD COLUMN IF NOT EXISTS email_status VARCHAR(190) DEFAULT NULL",
  ]
  for (const sql of alters) {
    try {
      await query(sql)
    } catch {
      // Column already exists / table not migrated / engine without IF NOT EXISTS.
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

/** Normalise a stored DATETIME ("YYYY-MM-DD HH:MM:SS" or Date) into local ISO. */
function toLocalDateTime(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(
      value.getHours(),
    )}:${pad(value.getMinutes())}:00`
  }
  const s = String(value)
  const dt = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/)
  if (dt) return `${dt[1]}T${dt[2]}:00`
  const d = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return d ? `${d[1]}T09:00:00` : null
}

function addMinutes(localDateTime: string, minutes: number): string {
  const start = new Date(localDateTime)
  const end = new Date(start.getTime() + minutes * 60_000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(
    end.getMinutes(),
  )}:00`
}

type InterviewRow = Record<string, any>

function eventSummary(row: InterviewRow): string {
  const who = row.candidate_name || row.candidate_id || "Candidate"
  const job = row.job_title ? ` (${row.job_title})` : ""
  const round = row.round ? ` — ${row.round}` : ""
  return `Interview: ${who}${job}${round}`
}

function eventDescription(row: InterviewRow): string {
  return [
    row.mode ? `Mode: ${row.mode}` : null,
    row.interviewer ? `Interviewer: ${row.interviewer}` : null,
    row.location ? `Location / link: ${row.location}` : null,
    row.interview_id ? `Reference: ${row.interview_id}` : null,
  ]
    .filter(Boolean)
    .join("\n")
}

/** Candidate email off the linked application (legacy rows store no email). */
async function candidateEmail(row: InterviewRow): Promise<string | null> {
  if (!row.application_id) return null
  try {
    const rows = (await query(
      "SELECT email FROM recruit_applications WHERE application_id = ? LIMIT 1",
      [row.application_id],
    )) as any[]
    return cleanEmail(rows[0]?.email)
  } catch {
    return null
  }
}

/** Persist the sync outcome back onto the interview row (by business id). */
async function persist(interviewId: string, patch: Record<string, any>) {
  const cols = Object.keys(patch)
  if (!cols.length) return
  await query(
    `UPDATE recruit_interviews SET ${cols.map((c) => `${c}=?`).join(", ")} WHERE interview_id = ?`,
    [...cols.map((c) => patch[c]), interviewId],
  )
}

/** Fan out candidate + interviewer notifications (in-app + calendar email invites). */
async function sendNotifications(
  row: InterviewRow,
  actorId: number | null,
  interviewerUserId: number | null,
  kind: "scheduled" | "rescheduled" | "cancelled",
  hasCalendarInvite: boolean,
  candidateEmailAddr: string | null,
  interviewerEmailAddr: string | null,
) {
  const when = toLocalDateTime(row.scheduled_at)?.replace("T", " ").slice(0, 16) || "an upcoming date"
  const candidate = row.candidate_name || "the candidate"

  const title = `Interview ${kind}: ${candidate}`
  const body =
    kind === "cancelled"
      ? `The interview for ${candidate} has been cancelled.`
      : `Interview for ${candidate} ${kind} for ${when}.`
  const link = "/modules/recruitment/interview-tracker"

  try {
    await ensureLeadLifecycleSchema()
  } catch {
    // notify() below is itself best-effort; continue regardless.
  }

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
    }).catch(() => {})
  }

  // When Google is connected the calendar invite IS the email notification
  // (sendUpdates:all); otherwise mark it pending so a recruiter reaches out.
  const hasAttendees = Boolean(candidateEmailAddr || interviewerEmailAddr)
  const emailStatus = hasCalendarInvite
    ? hasAttendees
      ? `Calendar invite ${kind === "cancelled" ? "cancellation " : ""}sent`
      : "No attendee emails on file"
    : hasAttendees
      ? "Pending — calendar not connected"
      : "No attendee emails on file"
  await persist(row.interview_id, { email_status: emailStatus }).catch(() => {})
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

export type LegacyInterviewSyncInput = {
  /** The current row state (merged existing + update). */
  record: InterviewRow
  /** The previous row state, used to reuse the stored event id. */
  existing?: InterviewRow | null
  actorId: number | null
  /** What happened: a fresh schedule, a reschedule, or a cancellation. */
  kind: "schedule" | "reschedule" | "cancel"
}

/**
 * Reconcile the legacy interview's Google Calendar event + notifications after
 * a schedule / reschedule / cancel. Reuses any stored `calendar_event_id` so a
 * reschedule never creates a duplicate event.
 */
export async function syncLegacyInterviewLifecycle(input: LegacyInterviewSyncInput): Promise<void> {
  await ensureLegacyInterviewSyncSchema()

  const row = input.record
  const interviewId = row.interview_id
  if (!interviewId) return

  const existingEventId: string | null =
    row.calendar_event_id || input.existing?.calendar_event_id || null
  const organizerId: number | null =
    Number(row.google_organizer_id || input.existing?.google_organizer_id) || input.actorId || null

  // Resolve interviewer (stable employee ref → email + in-app user) and candidate email.
  const interviewerRef = await resolveEmployeeRef(row.interviewer).catch(() => null)
  const interviewerEmail = interviewerRef?.email || null
  const candEmail = await candidateEmail(row)
  const attendees = [candEmail, interviewerEmail].filter(Boolean) as string[]
  const interviewerUserId = interviewerRef?.userId ?? null

  /* ----------------------------- Cancellation ---------------------------- */
  if (input.kind === "cancel") {
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
    await sendNotifications(
      row,
      input.actorId,
      interviewerUserId,
      "cancelled",
      Boolean(existingEventId),
      candEmail,
      interviewerEmail,
    ).catch(() => {})
    return
  }

  const startDateTime = toLocalDateTime(row.scheduled_at)
  if (!startDateTime) return // nothing to sync without a date/time
  const endDateTime = addMinutes(startDateTime, DEFAULT_DURATION_MINUTES)
  const verb = input.kind === "schedule" ? "scheduled" : "rescheduled"

  const account = organizerId ? await getGoogleAccount(organizerId).catch(() => null) : null

  // No connected Google account → keep the manual meeting link + notify.
  if (!account?.refresh_token) {
    await persist(interviewId, {
      google_sync_status: "Not Connected",
      meeting_link: row.meeting_link || row.location || null,
    })
    if (input.kind === "reschedule") await bumpReschedule(interviewId, input.existing)
    await sendNotifications(
      row,
      input.actorId,
      interviewerUserId,
      verb,
      false,
      candEmail,
      interviewerEmail,
    ).catch(() => {})
    return
  }

  const summary = eventSummary(row)
  const description = eventDescription(row)

  try {
    let eventId = existingEventId
    let meetLink: string | null = null
    let htmlLink: string | null = null

    if (existingEventId) {
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

    await persist(interviewId, {
      calendar_event_id: eventId,
      google_html_link: htmlLink,
      google_organizer_id: organizerId,
      google_sync_status: "Synced",
      google_sync_error: null,
      meeting_link: meetLink || row.meeting_link || row.location || null,
    })
    if (input.kind === "reschedule") await bumpReschedule(interviewId, input.existing)
    await sendNotifications(
      row,
      input.actorId,
      interviewerUserId,
      verb,
      true,
      candEmail,
      interviewerEmail,
    ).catch(() => {})
  } catch (err: any) {
    await persist(interviewId, {
      google_sync_status: "Failed",
      google_sync_error: String(err?.message || err).slice(0, 480),
    })
    await sendNotifications(
      row,
      input.actorId,
      interviewerUserId,
      verb,
      false,
      candEmail,
      interviewerEmail,
    ).catch(() => {})
  }
}

/** Bump the reschedule counter off the previous stored value. */
async function bumpReschedule(interviewId: string, existing?: InterviewRow | null) {
  const prev = Number(existing?.reschedule_count || 0)
  await persist(interviewId, { reschedule_count: prev + 1 }).catch(() => {})
}
