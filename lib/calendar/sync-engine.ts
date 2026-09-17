import "server-only"
import { query, tableColumns } from "@/lib/db"
import { getGoogleAccount } from "@/lib/google-accounts"
import {
  createMeetEventForUser,
  GoogleEventGoneError,
  isGoogleOAuthConfigured,
  updateMeetEventForUser,
  type CreateMeetInput,
} from "@/lib/google-calendar"
import { addMinutesWall, toDateString, wallClock, wallClockFromDateTime } from "./datetime"
import { logCalendarSync } from "./sync-log"

/**
 * Central reconciliation engine (spec Phases 30-33, 47-49, 71-73).
 *
 * Sources own their forward sync at write time. This engine is the SAFETY NET:
 * it periodically finds records whose Google sync ended up `Failed` (or was
 * left `Pending`) and retries them, reusing the stored event id so a retry
 * patches the existing event instead of creating a duplicate. Every attempt is
 * written to `calendar_sync_log`.
 *
 * It runs per-user (scoped to the records that user organises) so the manual
 * "Sync now" button and the unattended cron share exactly one code path.
 */

type Descriptor = {
  module: string
  table: string
  idCol: string
  eventIdCol: string
  statusCol: string
  errorCol: string | null
  htmlCol: string | null
  meetLinkCol: string | null
  organizerCols: string[]
  /** SQL predicate (no params) restricting to active, syncable rows. */
  activeWhere: string
  buildInput: (row: any) => CreateMeetInput | null
}

const DESCRIPTORS: Descriptor[] = [
  {
    module: "sales",
    table: "sales_meetings",
    idCol: "id",
    eventIdCol: "google_event_id",
    statusCol: "google_sync_status",
    errorCol: "google_sync_error",
    htmlCol: "google_html_link",
    meetLinkCol: "meet_link",
    organizerCols: ["google_organizer_id", "owner_id", "added_by"],
    activeWhere: "archived_at IS NULL AND (status IS NULL OR status <> 'Cancelled')",
    buildInput: (r) => {
      const date = toDateString(r.meeting_date)
      if (!date) return null
      const startWall = wallClock(date, r.meeting_time)
      const endWall = addMinutesWall(startWall, Number(r.duration_minutes) || 30)
      return {
        summary: `${r.meeting_type || "Meeting"}: ${r.company_name || r.meeting_code || ""}`.trim(),
        description: r.agenda || "",
        startDateTime: startWall,
        endDateTime: endWall,
        attendees: parseAttendees(r.attendees, r.contact_email),
      }
    },
  },
  {
    module: "operations",
    table: "operations_meetings",
    idCol: "id",
    eventIdCol: "google_event_id",
    statusCol: "google_sync_status",
    errorCol: "google_sync_error",
    htmlCol: "html_link",
    meetLinkCol: "meet_link",
    organizerCols: ["organizer_id", "created_by"],
    activeWhere: "(status IS NULL OR status <> 'Cancelled')",
    buildInput: (r) => {
      const startWall = wallClockFromDateTime(r.start_time)
      const endWall = wallClockFromDateTime(r.end_time) || (startWall ? addMinutesWall(startWall, 30) : null)
      if (!startWall || !endWall) return null
      return {
        summary: r.title || r.meeting_type || "Operations meeting",
        description: r.description || "",
        startDateTime: startWall,
        endDateTime: endWall,
        attendees: parseAttendees(r.attendees),
      }
    },
  },
  {
    module: "recruitment",
    table: "recruitment_interviews",
    idCol: "interview_id",
    eventIdCol: "calendar_event_id",
    statusCol: "google_sync_status",
    errorCol: "google_sync_error",
    htmlCol: "google_html_link",
    meetLinkCol: "meeting_link",
    organizerCols: ["google_organizer_id"],
    activeWhere: "(interview_status IS NULL OR interview_status <> 'Cancelled')",
    buildInput: (r) => {
      const date = toDateString(r.interview_date)
      if (!date) return null
      const startWall = wallClock(date, r.interview_time)
      const endWall = addMinutesWall(startWall, 60)
      return {
        summary: `Interview: ${r.candidate_name || "Candidate"}${
          r.interview_round ? ` — ${r.interview_round}` : ""
        }`,
        description: [r.job_applied, r.interview_mode, r.interviewer].filter(Boolean).join(" · "),
        startDateTime: startWall,
        endDateTime: endWall,
        attendees: parseAttendees(r.candidate_email, r.interviewer_email),
      }
    },
  },
]

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function parseAttendees(...sources: unknown[]): string[] {
  const out = new Set<string>()
  for (const src of sources) {
    if (!src) continue
    let items: string[] = []
    if (Array.isArray(src)) items = src.map(String)
    else {
      const s = String(src)
      try {
        const parsed = JSON.parse(s)
        items = Array.isArray(parsed) ? parsed.map(String) : s.split(/[\s,;]+/)
      } catch {
        items = s.split(/[\s,;]+/)
      }
    }
    for (const it of items) {
      const e = it.trim().toLowerCase()
      if (e && EMAIL_RE.test(e)) out.add(e)
    }
  }
  return [...out]
}

export type ReconcileResult = {
  module: string
  retried: number
  synced: number
  failed: number
}

async function reconcileDescriptor(
  d: Descriptor,
  userId: number,
  refreshToken: string,
): Promise<ReconcileResult> {
  const result: ReconcileResult = { module: d.module, retried: 0, synced: 0, failed: 0 }
  let cols: Set<string>
  try {
    cols = await tableColumns(d.table)
  } catch {
    return result
  }
  if (!cols.has(d.statusCol) || !cols.has(d.eventIdCol)) return result

  const organizerCols = d.organizerCols.filter((c) => cols.has(c))
  if (organizerCols.length === 0) return result
  const organizerPredicate = `(${organizerCols.map((c) => `${c} = ?`).join(" OR ")})`

  let rows: any[]
  try {
    rows = await query<any[]>(
      `SELECT * FROM ${d.table}
        WHERE ${organizerPredicate}
          AND ${d.statusCol} IN ('Failed', 'Pending')
          AND ${d.activeWhere}
        ORDER BY ${d.idCol} DESC
        LIMIT 100`,
      organizerCols.map(() => userId),
    )
  } catch (error) {
    console.error(`[v0] reconcile ${d.module} query failed:`, (error as Error).message)
    return result
  }

  for (const row of rows) {
    result.retried++
    const recordId = row[d.idCol]
    const input = d.buildInput(row)
    if (!input || input.attendees.length === 0) {
      // Nothing actionable (e.g. no attendees) — leave as-is, don't thrash.
      continue
    }
    const existingEventId: string | null = row[d.eventIdCol] || null
    try {
      const res = existingEventId
        ? await updateMeetEventForUser(refreshToken, existingEventId, input)
        : await createMeetEventForUser(refreshToken, input)

      const sets: string[] = [`${d.eventIdCol} = ?`, `${d.statusCol} = 'Synced'`]
      const params: unknown[] = [res.eventId]
      if (d.errorCol && cols.has(d.errorCol)) sets.push(`${d.errorCol} = NULL`)
      if (d.htmlCol && cols.has(d.htmlCol) && res.htmlLink) {
        sets.push(`${d.htmlCol} = ?`)
        params.push(res.htmlLink)
      }
      if (d.meetLinkCol && cols.has(d.meetLinkCol) && res.meetLink) {
        sets.push(`${d.meetLinkCol} = ?`)
        params.push(res.meetLink)
      }
      params.push(recordId)
      await query(`UPDATE ${d.table} SET ${sets.join(", ")} WHERE ${d.idCol} = ?`, params)

      result.synced++
      await logCalendarSync({
        module: d.module,
        recordId,
        userId,
        action: "retried",
        status: "Synced",
        externalEventId: res.eventId,
      })
    } catch (error) {
      result.failed++
      const gone = error instanceof GoogleEventGoneError
      // The linked event vanished on Google — drop the stale id so the next
      // pass recreates it cleanly instead of patching a ghost.
      const sets = gone
        ? [`${d.eventIdCol} = NULL`, `${d.statusCol} = 'Failed'`]
        : [`${d.statusCol} = 'Failed'`]
      const params: unknown[] = []
      const message = (error as Error).message?.slice(0, 480) || "sync failed"
      if (d.errorCol && cols.has(d.errorCol)) {
        sets.push(`${d.errorCol} = ?`)
        params.push(message)
      }
      params.push(recordId)
      try {
        await query(`UPDATE ${d.table} SET ${sets.join(", ")} WHERE ${d.idCol} = ?`, params)
      } catch {
        // best-effort status write
      }
      await logCalendarSync({
        module: d.module,
        recordId,
        userId,
        action: "sync_failed",
        status: "Failed",
        externalEventId: existingEventId,
        message,
      })
    }
  }

  return result
}

export type UserReconcileResult = {
  userId: number
  connected: boolean
  results: ReconcileResult[]
}

/** Reconcile every source for one user. Shared by the manual button and cron. */
export async function reconcileUser(userId: number): Promise<UserReconcileResult> {
  if (!isGoogleOAuthConfigured()) {
    return { userId, connected: false, results: [] }
  }
  const account = await getGoogleAccount(userId).catch(() => null)
  if (!account?.refresh_token) {
    return { userId, connected: false, results: [] }
  }
  const results: ReconcileResult[] = []
  for (const d of DESCRIPTORS) {
    results.push(await reconcileDescriptor(d, userId, account.refresh_token))
  }
  return { userId, connected: true, results }
}

/**
 * Reconcile every user that has a connected Google account. Used by the cron.
 * Users are processed sequentially to stay well within Google rate limits.
 */
export async function reconcileAllUsers(): Promise<{
  users: number
  totals: { retried: number; synced: number; failed: number }
}> {
  let userIds: number[] = []
  try {
    const rows = await query<{ user_id: number }[]>(
      "SELECT user_id FROM sales_google_accounts",
    )
    userIds = rows.map((r) => r.user_id)
  } catch (error) {
    console.error("[v0] reconcileAllUsers: could not list accounts:", (error as Error).message)
    return { users: 0, totals: { retried: 0, synced: 0, failed: 0 } }
  }

  const totals = { retried: 0, synced: 0, failed: 0 }
  for (const userId of userIds) {
    const { results } = await reconcileUser(userId)
    for (const r of results) {
      totals.retried += r.retried
      totals.synced += r.synced
      totals.failed += r.failed
    }
  }
  return { users: userIds.length, totals }
}
