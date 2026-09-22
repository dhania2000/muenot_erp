import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureAttendanceSchema, getTimeZone } from "@/lib/hr-attendance"

// ---------------------------------------------------------------------------
// Non-work time reporting for the currently clocked-in employee.
//
// Two DISTINCT client sources feed this endpoint, distinguished by `type`, both
// reporting TOTAL elapsed minutes for their stretch:
//   1. type "idle" (default) — Inactivity: the full continuous no-activity
//      stretch once it crosses the grace window (see attendance-idle-config for
//      the single source of truth). Accumulated into `idle_minutes`. The grace
//      window applies to this: at clock-out Break = Idle - grace, so the first
//      `grace` minutes stay paid work and only the remainder becomes break.
//   2. type "screen-missing" — while the employee has not shared their entire
//      screen (denied / stopped / unsupported / wrong surface). Accumulated into
//      `screen_missing_minutes`. There is NO grace here: every reported minute
//      becomes break at clock-out. Kept in its own column so reports can tell
//      screen-missing break apart from idle break.
//
// Both columns live on today's OPEN attendance row and are consumed by the
// clock route at clock-out (Break = max(0, idle - grace) + screen_missing).
// ---------------------------------------------------------------------------

/** Reports below this (minutes) are noise and ignored — the client pre-graces. */
const MIN_REPORT_MINUTES = 1
/** Defensive cap so a single report can never poison the row. */
const MAX_SINGLE_REPORT_MINUTES = 16 * 60

function todayInTz(timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  return fmt.format(new Date())
}

export async function POST(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    await ensureAttendanceSchema()
    const timeZone = await getTimeZone()

    let body: { minutes?: unknown; type?: unknown } = {}
    try {
      body = await request.json()
    } catch {
      // ignore — validated below
    }
    const minutes = Number(body.minutes)
    if (!Number.isFinite(minutes) || minutes < MIN_REPORT_MINUTES) {
      return NextResponse.json({ ok: true, skipped: true })
    }
    const capped = Math.min(Math.round(minutes), MAX_SINGLE_REPORT_MINUTES)
    // Screen-missing time goes to its own no-grace column; everything else is idle.
    const isScreenMissing = body.type === "screen-missing"

    // Resolve the employee linked to this session's login email.
    const emp = await query<{ id: number }[]>(
      "SELECT id FROM hr_employees WHERE official_email = ? OR personal_email = ? ORDER BY id LIMIT 1",
      [session.email, session.email],
    )
    if (!emp[0]) return NextResponse.json({ ok: true, skipped: true })

    const workDate = todayInTz(timeZone)

    // Read today's row defensively — `active_since` may not exist on older DBs.
    type Row = {
      id: number
      clock_in: string | null
      clock_out: string | null
      active_since?: string | null
      idle_minutes: number
      screen_missing_minutes?: number
    }
    let row: Row | undefined
    try {
      row = (
        await query<Row[]>(
          "SELECT id, clock_in, clock_out, active_since, idle_minutes, screen_missing_minutes FROM hr_attendance WHERE employee_id = ? AND work_date = ? LIMIT 1",
          [emp[0].id, workDate],
        )
      )[0]
    } catch {
      row = (
        await query<Row[]>(
          "SELECT id, clock_in, clock_out, idle_minutes FROM hr_attendance WHERE employee_id = ? AND work_date = ? LIMIT 1",
          [emp[0].id, workDate],
        )
      )[0]
    }
    if (!row) return NextResponse.json({ ok: true, skipped: true })

    // Only accrue against an OPEN session (either a live session marker, or a
    // clock-in with no clock-out yet).
    const open = row.active_since ? true : Boolean(row.clock_in && !row.clock_out)
    if (!open) return NextResponse.json({ ok: true, skipped: true })

    if (isScreenMissing) {
      const nextMinutes = Math.round(Number(row.screen_missing_minutes || 0)) + capped
      try {
        await query("UPDATE hr_attendance SET screen_missing_minutes = ? WHERE id = ?", [nextMinutes, row.id])
        return NextResponse.json({ ok: true, screenMissingMinutes: nextMinutes })
      } catch {
        // Column not present (lazy migration blocked). Fall back to idle so the
        // time is not lost; it will get the grace, which is an acceptable
        // degraded behaviour on such databases.
        const idleMinutes = Math.round(Number(row.idle_minutes || 0)) + capped
        await query("UPDATE hr_attendance SET idle_minutes = ? WHERE id = ?", [idleMinutes, row.id])
        return NextResponse.json({ ok: true, idleMinutes })
      }
    }

    const idleMinutes = Math.round(Number(row.idle_minutes || 0)) + capped
    await query("UPDATE hr_attendance SET idle_minutes = ? WHERE id = ?", [idleMinutes, row.id])

    return NextResponse.json({ ok: true, idleMinutes })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to record idle time" },
      { status: 500 },
    )
  }
}
