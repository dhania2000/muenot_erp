import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureAttendanceSchema, getTimeZone } from "@/lib/hr-attendance"

// ---------------------------------------------------------------------------
// Non-work time reporting for the currently clocked-in employee.
//
// Two client sources feed this endpoint, both reporting minutes that must be
// treated as break rather than attendance:
//   1. Inactivity — every minute past the configured no-activity grace window
//      (see lib/attendance-idle-config.ts for the single source of truth; the
//      idle tracker already subtracts the grace before reporting).
//   2. Screen not shared — while the employee has not shared their entire
//      screen (permission denied or sharing stopped) the whole elapsed time is
//      reported (no grace), because unmonitored time never counts as work.
//
// We accumulate the reported minutes into `idle_minutes` on today's OPEN
// attendance row. At clock-out the clock route subtracts it from worked hours
// and adds it to the break total, so this time never counts as attendance.
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

    let body: { minutes?: unknown } = {}
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

    // Resolve the employee linked to this session's login email.
    const emp = await query<{ id: number }[]>(
      "SELECT id FROM hr_employees WHERE official_email = ? OR personal_email = ? ORDER BY id LIMIT 1",
      [session.email, session.email],
    )
    if (!emp[0]) return NextResponse.json({ ok: true, skipped: true })

    const workDate = todayInTz(timeZone)

    // Read today's row defensively — `active_since` may not exist on older DBs.
    type Row = { id: number; clock_in: string | null; clock_out: string | null; active_since?: string | null; idle_minutes: number }
    let row: Row | undefined
    try {
      row = (
        await query<Row[]>(
          "SELECT id, clock_in, clock_out, active_since, idle_minutes FROM hr_attendance WHERE employee_id = ? AND work_date = ? LIMIT 1",
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

    // Only accrue idle against an OPEN session (either a live session marker, or
    // a clock-in with no clock-out yet).
    const open = row.active_since ? true : Boolean(row.clock_in && !row.clock_out)
    if (!open) return NextResponse.json({ ok: true, skipped: true })

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
