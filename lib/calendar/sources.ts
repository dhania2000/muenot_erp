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
  /** The acting tenant, used to scope tenant-owned sources (tasks). */
  tenantId: number | null
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

/* -------------------------------------------------------------------------- */
/* Tasks & Deadlines (Spec 110 → 111)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Surface the current user's tasks (Spec 110 `tasks`) in the central calendar.
 * A task appears when the user created it or is an assignee/watcher on it.
 * Tasks are tenant-owned, so they are always scoped to the acting tenant.
 *
 * Each task is projected onto its DUE date (its deadline). Tasks flagged as a
 * hard deadline — priority urgent/high, or explicitly `related_entity='deadline'`
 * — are categorised as "Deadline" (all-day marker); the rest are "Task".
 * Completed/cancelled tasks keep showing so history stays accurate.
 */
export async function readTasksAndDeadlines(win: SourceWindow): Promise<UnifiedCalendarEvent[]> {
  try {
    if (win.tenantId == null) return []
    const cols = await tableColumns("tasks")
    if (!cols.size) return []
    const hasDueAt = cols.has("due_at")
    const hasDueDate = cols.has("due_date")
    if (!hasDueAt && !hasDueDate) return []

    const dueExpr = hasDueAt && hasDueDate ? "COALESCE(t.due_at, t.due_date)" : hasDueAt ? "t.due_at" : "t.due_date"
    const fromDt = `${win.fromDate} 00:00:00`
    const toDt = `${win.toDate} 23:59:59`
    const hasAssignees = (await tableColumns("task_assignees")).has("task_id")

    const ownership = hasAssignees
      ? "(t.created_by = ? OR EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ?))"
      : "t.created_by = ?"
    const args: unknown[] = hasAssignees
      ? [win.tenantId, win.userId, win.userId, fromDt, toDt]
      : [win.tenantId, win.userId, fromDt, toDt]

    const rows = await query<any[]>(
      `SELECT t.* FROM tasks t
        WHERE t.tenant_id = ?
          AND ${ownership}
          AND ${dueExpr} IS NOT NULL
          AND ${dueExpr} BETWEEN ? AND ?
        ORDER BY ${dueExpr}
        LIMIT 500`,
      args,
    )
    return rows.map((r) => {
      const rawDue = hasDueAt && r.due_at ? r.due_at : r.due_date
      const timed = hasDueAt && r.due_at && !/^\d{4}-\d{2}-\d{2}$/.test(String(r.due_at).trim())
      const startWall = timed ? wallClockFromDateTime(rawDue) : null
      const dateStr = toDateString(rawDue)!
      const priority = String(r.priority || "").toLowerCase()
      const status = String(r.status || "")
      const cancelled = status === "cancelled"
      const isDeadline =
        priority === "urgent" || priority === "high" || String(r.related_entity || "") === "deadline"
      return {
        id: `tasks:${r.id}`,
        title: `${isDeadline ? "Deadline" : "Task"}: ${r.title || "Untitled task"}`,
        start: startWall ? toIstIso(startWall)! : dateStr,
        end: startWall ? toIstIso(addMinutesWall(startWall, 30)) : null,
        allDay: !startWall,
        location: null,
        description: r.description || null,
        hangoutLink: null,
        htmlLink: null,
        status: r.status || null,
        sourceModule: isDeadline ? "deadline" : "tasks",
        sourceRecordId: String(r.id),
        category: isDeadline ? "Deadline" : "Task",
        organizer: null,
        externalEventId: null,
        googleSyncStatus: cancelled ? "Cancelled" : null,
        href: `/modules/tasks?id=${r.id}`,
      }
    })
  } catch {
    return []
  }
}

/* -------------------------------------------------------------------------- */
/* Sales follow-ups (Spec 111)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Surface the user's open sales follow-ups (`sales_lead_followups`) on their
 * due date. Done/cancelled follow-ups still appear so the day's history reads
 * correctly. Scoped to follow-ups the user owns (assigned_to / created_by).
 */
export async function readFollowUps(win: SourceWindow): Promise<UnifiedCalendarEvent[]> {
  try {
    const cols = await tableColumns("sales_lead_followups")
    if (!cols.has("due_at")) return []
    const fromDt = `${win.fromDate} 00:00:00`
    const toDt = `${win.toDate} 23:59:59`
    const leadCols = await tableColumns("sales_leads")
    const leadJoin = leadCols.size
      ? "LEFT JOIN sales_leads l ON l.id = f.lead_id"
      : ""
    const leadName = leadCols.has("company_name")
      ? "l.company_name"
      : leadCols.has("contact_name")
        ? "l.contact_name"
        : "NULL"
    const rows = await query<any[]>(
      `SELECT f.*, ${leadName} AS lead_name FROM sales_lead_followups f
        ${leadJoin}
        WHERE (f.assigned_to = ? OR f.created_by = ?)
          AND f.due_at BETWEEN ? AND ?
        ORDER BY f.due_at
        LIMIT 500`,
      [win.userId, win.userId, fromDt, toDt],
    )
    return rows.map((r) => {
      const startWall = wallClockFromDateTime(r.due_at)
      const cancelled = String(r.status || "") === "Cancelled"
      const who = r.lead_name || `Lead #${r.lead_id}`
      return {
        id: `followup:${r.id}`,
        title: `Follow-up: ${who}`,
        start: toIstIso(startWall) || String(r.due_at),
        end: null,
        allDay: false,
        location: null,
        description: [r.purpose, r.channel ? `Channel: ${r.channel}` : null, r.outcome]
          .filter(Boolean)
          .join("\n") || null,
        hangoutLink: null,
        htmlLink: null,
        status: r.status || null,
        sourceModule: "followup",
        sourceRecordId: String(r.id),
        category: "Follow-up",
        organizer: null,
        externalEventId: null,
        googleSyncStatus: cancelled ? "Cancelled" : null,
        href: `/modules/sales/followups?id=${r.id}`,
      }
    })
  } catch {
    return []
  }
}

/* -------------------------------------------------------------------------- */
/* Leave (Spec 111)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Surface the signed-in employee's leave (`hr_leave_requests`) as all-day
 * multi-day events spanning from_date..to_date. Only the user's own requests
 * are shown, matched via their HR employee id. Rejected requests are omitted;
 * cancelled ones are flagged.
 */
export async function readLeave(win: SourceWindow): Promise<UnifiedCalendarEvent[]> {
  try {
    const cols = await tableColumns("hr_leave_requests")
    if (!cols.has("from_date")) return []
    if (!win.email) return []

    // Resolve the user's HR employee id.
    const empCols = await tableColumns("hr_employees")
    const emailPred = empCols.has("personal_email")
      ? "official_email = ? OR personal_email = ?"
      : "official_email = ?"
    const empArgs = empCols.has("personal_email") ? [win.email, win.email] : [win.email]
    const [emp] = await query<any[]>(
      `SELECT id FROM hr_employees WHERE ${emailPred} LIMIT 1`,
      empArgs,
    )
    if (!emp) return []

    const rows = await query<any[]>(
      `SELECT * FROM hr_leave_requests
        WHERE employee_id = ?
          AND status NOT IN ('Manager Rejected','HR Rejected')
          AND from_date <= ?
          AND to_date >= ?
        ORDER BY from_date
        LIMIT 500`,
      [emp.id, win.toDate, win.fromDate],
    )
    return rows.map((r) => {
      const from = toDateString(r.from_date)!
      const to = toDateString(r.to_date) || from
      const cancelled = String(r.status || "") === "Cancelled"
      return {
        id: `leave:${r.id}`,
        title: `Leave: ${r.leave_type_id || "Time off"}`,
        start: from,
        end: to,
        allDay: true,
        location: null,
        description: [r.reason, `Status: ${r.status}`, `${r.days} day(s)`].filter(Boolean).join("\n") || null,
        hangoutLink: null,
        htmlLink: null,
        status: r.status || null,
        sourceModule: "leave",
        sourceRecordId: String(r.id),
        category: "Leave",
        organizer: r.employee_name || null,
        externalEventId: null,
        googleSyncStatus: cancelled ? "Cancelled" : null,
        href: `/modules/hr/leave-requests?id=${r.id}`,
      }
    })
  } catch {
    return []
  }
}

/* -------------------------------------------------------------------------- */
/* Training (Spec 111)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Surface scheduled training sessions. There is no dedicated training table in
 * every install, so this reader probes the likely candidates and degrades to an
 * empty list when none exist — the calendar simply shows no Training events
 * until an HR training module ships a table with these columns.
 */
export async function readTrainings(win: SourceWindow): Promise<UnifiedCalendarEvent[]> {
  for (const table of ["hr_trainings", "training_sessions", "hr_training_sessions"]) {
    try {
      const cols = await tableColumns(table)
      if (!cols.has("start_at") && !cols.has("session_date")) continue
      const timed = cols.has("start_at")
      const dateCol = timed ? "start_at" : "session_date"
      const endCol = cols.has("end_at") ? "end_at" : null
      const titleCol = cols.has("title") ? "title" : cols.has("name") ? "name" : "NULL"
      const fromDt = timed ? `${win.fromDate} 00:00:00` : win.fromDate
      const toDt = timed ? `${win.toDate} 23:59:59` : win.toDate
      const rows = await query<any[]>(
        `SELECT *, ${titleCol} AS _title FROM ${table}
          WHERE ${dateCol} BETWEEN ? AND ?
          ORDER BY ${dateCol}
          LIMIT 500`,
        [fromDt, toDt],
      )
      return rows.map((r) => {
        const startWall = timed ? wallClockFromDateTime(r[dateCol]) : null
        const endWall = endCol && r[endCol] ? wallClockFromDateTime(r[endCol]) : null
        const date = toDateString(r[dateCol])!
        return {
          id: `training:${r.id}`,
          title: `Training: ${r._title || "Session"}`,
          start: startWall ? toIstIso(startWall)! : date,
          end: endWall ? toIstIso(endWall) : null,
          allDay: !startWall,
          location: r.location || null,
          description: r.description || null,
          hangoutLink: r.meeting_link || r.meet_link || null,
          htmlLink: null,
          status: r.status || null,
          sourceModule: "training",
          sourceRecordId: String(r.id),
          category: "Training",
          organizer: r.trainer || r.host_name || null,
          externalEventId: null,
          googleSyncStatus: null,
          href: `/modules/hr/training?id=${r.id}`,
        }
      })
    } catch {
      // try the next candidate table
    }
  }
  return []
}

/** Read every ERP source for the user in the window (Google added separately). */
export async function readErpSources(win: SourceWindow): Promise<UnifiedCalendarEvent[]> {
  const results = await Promise.all([
    readSalesMeetings(win),
    readOperationsMeetings(win),
    readRecruitmentInterviews(win),
    readCompanyEvents(win),
    readTasksAndDeadlines(win),
    readFollowUps(win),
    readLeave(win),
    readTrainings(win),
  ])
  return results.flat()
}
