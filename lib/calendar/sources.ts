import "server-only"
import { query, tableColumns } from "@/lib/db"
import type { UnifiedCalendarEvent } from "./types"
import {
  addMinutesWall,
  toDateString,
  toIstIso,
  wallClock,
  wallClockFromDateTime,
} from "./datetime"

/**
 * Source readers (spec Phases 5-13).
 *
 * Each reader pulls the CURRENT USER's own scheduled records from an existing
 * ERP source table and projects them into the unified event shape. No new
 * meeting/interview storage is created — the source tables remain the single
 * source of truth; we only read and display them centrally.
 *
 * Every reader is defensive: if the table or an expected column is missing on
 * an older install it degrades to an empty list rather than throwing, so one
 * lagging source never blanks the whole calendar.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function parseAttendeeList(raw: unknown): string[] {
  if (!raw) return []
  let arr: string[] = []
  if (Array.isArray(raw)) arr = raw.map(String)
  else {
    const s = String(raw)
    try {
      const parsed = JSON.parse(s)
      arr = Array.isArray(parsed) ? parsed.map(String) : s.split(/[\s,;]+/)
    } catch {
      arr = s.split(/[\s,;]+/)
    }
  }
  const seen = new Set<string>()
  for (const item of arr) {
    const e = item.trim().toLowerCase()
    if (e && EMAIL_RE.test(e)) seen.add(e)
  }
  return [...seen]
}

function mapGoogleSyncStatus(raw: unknown): UnifiedCalendarEvent["googleSyncStatus"] {
  const s = String(raw ?? "").trim()
  if (!s) return null
  const allowed = ["Synced", "Pending", "Failed", "Not Connected", "Cancelled", "Disconnected"]
  return (allowed.includes(s) ? s : null) as UnifiedCalendarEvent["googleSyncStatus"]
}

export type SourceWindow = {
  userId: number
  email: string | null
  /** Inclusive IST date bounds "YYYY-MM-DD". */
  fromDate: string
  toDate: string
}

/* -------------------------------------------------------------------------- */
/* Sales meetings (Phase 9)                                                   */
/* -------------------------------------------------------------------------- */

export async function readSalesMeetings(win: SourceWindow): Promise<UnifiedCalendarEvent[]> {
  try {
    const cols = await tableColumns("sales_meetings")
    if (!cols.has("meeting_date")) return []
    const rows = await query<any[]>(
      `SELECT m.*, u.name AS owner_name, c.company_name AS company_master_name
         FROM sales_meetings m
         LEFT JOIN users u ON u.id = m.owner_id
         LEFT JOIN sales_companies c ON c.id = m.company_id
        WHERE (m.owner_id = ? OR m.added_by = ?)
          AND (m.archived_at IS NULL)
          AND m.meeting_date BETWEEN ? AND ?
        ORDER BY m.meeting_date, m.meeting_time
        LIMIT 500`,
      [win.userId, win.userId, win.fromDate, win.toDate],
    )
    return rows.map((r) => {
      const date = toDateString(r.meeting_date)!
      const startWall = wallClock(date, r.meeting_time)
      const endWall = addMinutesWall(startWall, Number(r.duration_minutes) || 30)
      const company = r.company_master_name || r.company_name || r.meeting_code
      const cancelled = String(r.status || "") === "Cancelled"
      return {
        id: `sales:${r.id}`,
        title: `${r.meeting_type || "Meeting"}: ${company}`,
        start: toIstIso(startWall)!,
        end: toIstIso(endWall),
        allDay: false,
        location: r.location || null,
        description: r.agenda || r.internal_notes || null,
        hangoutLink: r.meet_link || null,
        htmlLink: r.google_html_link || null,
        status: r.status || null,
        sourceModule: "sales",
        sourceRecordId: String(r.id),
        category: "Sales",
        organizer: r.owner_name || null,
        externalEventId: r.google_event_id || null,
        googleSyncStatus: cancelled ? "Cancelled" : mapGoogleSyncStatus(r.google_sync_status),
        href: `/modules/sales/meetings?id=${r.id}`,
      }
    })
  } catch {
    return []
  }
}

/* -------------------------------------------------------------------------- */
/* Operations meetings (Phase 10)                                             */
/* -------------------------------------------------------------------------- */

export async function readOperationsMeetings(win: SourceWindow): Promise<UnifiedCalendarEvent[]> {
  try {
    const cols = await tableColumns("operations_meetings")
    if (!cols.has("start_time")) return []
    const fromDt = `${win.fromDate} 00:00:00`
    const toDt = `${win.toDate} 23:59:59`
    const rows = await query<any[]>(
      `SELECT m.*, u.name AS organizer_user_name
         FROM operations_meetings m
         LEFT JOIN users u ON u.id = m.organizer_id
        WHERE (m.organizer_id = ? OR m.created_by = ?)
          AND m.start_time BETWEEN ? AND ?
        ORDER BY m.start_time
        LIMIT 500`,
      [win.userId, win.userId, fromDt, toDt],
    )
    return rows.map((r) => {
      const startWall = wallClockFromDateTime(r.start_time)
      const endWall = wallClockFromDateTime(r.end_time)
      const cancelled = String(r.status || "") === "Cancelled"
      return {
        id: `operations:${r.id}`,
        title: r.title || r.meeting_type || "Operations meeting",
        start: toIstIso(startWall) || String(r.start_time),
        end: toIstIso(endWall),
        allDay: false,
        location: r.location || null,
        description: r.description || null,
        hangoutLink: r.meet_link || null,
        htmlLink: r.html_link || null,
        status: r.status || null,
        sourceModule: "operations",
        sourceRecordId: String(r.id),
        category: "Operations",
        organizer: r.organizer_user_name || r.organizer_name || null,
        externalEventId: r.google_event_id || null,
        googleSyncStatus: cancelled
          ? "Cancelled"
          : r.google_event_id
            ? "Synced"
            : null,
        href: r.project_id
          ? `/modules/operations/projects?id=${r.project_id}`
          : `/modules/operations/meetings?id=${r.id}`,
      }
    })
  } catch {
    return []
  }
}

/* -------------------------------------------------------------------------- */
/* Recruitment interviews (Phases 5-7)                                        */
/* -------------------------------------------------------------------------- */

export async function readRecruitmentInterviews(win: SourceWindow): Promise<UnifiedCalendarEvent[]> {
  try {
    const cols = await tableColumns("recruitment_interviews")
    if (!cols.has("interview_date")) return []
    const email = (win.email || "").toLowerCase()
    const rows = await query<any[]>(
      `SELECT * FROM recruitment_interviews
        WHERE (google_organizer_id = ? ${cols.has("interviewer_email") ? "OR LOWER(interviewer_email) = ?" : ""})
          AND interview_date BETWEEN ? AND ?
        ORDER BY interview_date
        LIMIT 500`,
      cols.has("interviewer_email")
        ? [win.userId, email, win.fromDate, win.toDate]
        : [win.userId, win.fromDate, win.toDate],
    )
    return rows.map((r) => {
      const date = toDateString(r.interview_date)!
      const startWall = wallClock(date, r.interview_time)
      const endWall = addMinutesWall(startWall, 60)
      const who = r.candidate_name || r.candidate_id || "Candidate"
      const round = r.interview_round ? ` — ${r.interview_round}` : ""
      const status = String(r.interview_status || "Scheduled")
      const cancelled = status === "Cancelled"
      return {
        id: `recruitment:${r.interview_id || r.id}`,
        title: `Interview: ${who}${round}`,
        start: toIstIso(startWall)!,
        end: toIstIso(endWall),
        allDay: false,
        location: r.interview_link_location || null,
        description: [
          r.interview_type ? `Type: ${r.interview_type}` : null,
          r.interview_mode ? `Mode: ${r.interview_mode}` : null,
          r.interviewer ? `Interviewer: ${r.interviewer}` : null,
          r.job_applied ? `Job: ${r.job_applied}` : null,
        ]
          .filter(Boolean)
          .join("\n") || null,
        hangoutLink: r.meeting_link || null,
        htmlLink: r.google_html_link || null,
        status,
        sourceModule: "recruitment",
        sourceRecordId: String(r.interview_id || r.id),
        category: "Interview",
        organizer: r.interviewer || null,
        externalEventId: r.calendar_event_id || null,
        googleSyncStatus: cancelled ? "Cancelled" : mapGoogleSyncStatus(r.google_sync_status),
        href: `/modules/recruitment/interview-schedule`,
      }
    })
  } catch {
    return []
  }
}

/* -------------------------------------------------------------------------- */
/* Company events (Events module → My Calendar, spec Phases 51-53)             */
/* -------------------------------------------------------------------------- */

/**
 * Surface the Events module (`hr_events`) in the user's central calendar.
 * An event appears when the signed-in user is genuinely connected to it:
 * they created it, host it, it targets all employees, their name is listed as
 * a specific attendee, or they are an assigned participant. Cancelled events
 * are still shown (flagged "Cancelled") so the calendar reflects the change.
 * The Events module remains the single source of truth — nothing is copied.
 */
export async function readCompanyEvents(win: SourceWindow): Promise<UnifiedCalendarEvent[]> {
  try {
    const cols = await tableColumns("hr_events")
    if (!cols.has("start_at")) return []

    // Resolve this user's HR employee identity for attendee/participant matching.
    let empPk: number | null = null
    let empName: string | null = null
    if (win.email) {
      const [emp] = await query<any[]>(
        "SELECT id, employee_name FROM hr_employees WHERE official_email = ? OR personal_email = ? LIMIT 1",
        [win.email, win.email],
      )
      if (emp) {
        empPk = Number(emp.id)
        empName = emp.employee_name ?? null
      }
    }

    const fromDt = `${win.fromDate} 00:00:00`
    const toDt = `${win.toDate} 23:59:59`
    const hasParticipants = (await tableColumns("event_participants")).has("employee_pk")

    // Build the relevance predicate. Order of args MUST match placeholder order.
    const conds: string[] = ["e.attendee_type = 'all_employees'", "e.created_by = ?"]
    const args: unknown[] = [fromDt, toDt, win.userId]
    if (empName) {
      conds.push("e.host_name = ?")
      args.push(empName)
      conds.push("(e.attendees IS NOT NULL AND JSON_SEARCH(e.attendees, 'one', ?) IS NOT NULL)")
      args.push(empName)
    }
    if (empPk != null && hasParticipants) {
      conds.push("EXISTS (SELECT 1 FROM event_participants p WHERE p.event_id = e.id AND p.employee_pk = ?)")
      args.push(empPk)
    }

    const rows = await query<any[]>(
      `SELECT e.* FROM hr_events e
        WHERE e.start_at BETWEEN ? AND ?
          AND (${conds.join(" OR ")})
        ORDER BY e.start_at
        LIMIT 500`,
      args,
    )
    return rows.map((r) => {
      const startWall = wallClockFromDateTime(r.start_at)
      const endWall = wallClockFromDateTime(r.end_at)
      const cancelled = String(r.status || "").toLowerCase() === "cancelled"
      return {
        id: `events:${r.id}`,
        title: r.name || "Event",
        start: toIstIso(startWall) || String(r.start_at),
        end: toIstIso(endWall),
        allDay: false,
        location: r.location || null,
        description: r.description || r.meeting_details || null,
        hangoutLink: null,
        htmlLink: null,
        status: r.status || null,
        sourceModule: "events",
        sourceRecordId: String(r.id),
        category: "Events",
        organizer: r.host_name || r.created_by_name || null,
        externalEventId: null,
        googleSyncStatus: cancelled ? "Cancelled" : null,
        href: `/modules/events`,
      }
    })
  } catch {
    return []
  }
}

/** Read every ERP source for the user in the window (Google added separately). */
export async function readErpSources(win: SourceWindow): Promise<UnifiedCalendarEvent[]> {
  const results = await Promise.all([
    readSalesMeetings(win),
    readOperationsMeetings(win),
    readRecruitmentInterviews(win),
    readCompanyEvents(win),
  ])
  return results.flat()
}
