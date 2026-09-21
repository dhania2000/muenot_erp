import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureAttendanceSchema, getTimeZone } from "@/lib/hr-attendance"

// ---------------------------------------------------------------------------
// Idle-time reporting for the currently clocked-in employee.
//
// The clock widget reports a continuous away-from-screen period (screen off,
// window minimised, or another app in focus) once it exceeds the grace window.
// We accumulate that into `idle_minutes` on today's OPEN attendance row. At
// clock-out the clock route subtracts it from worked hours and adds it to the
// break total, so long idle stretches never count as attendance.
// ---------------------------------------------------------------------------

/** Only away periods longer than this (minutes) are reported and reclassified. */
const IDLE_GRACE_MINUTES = 10
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
    if (!Number.isFinite(minutes) || minutes < IDLE_GRACE_MINUTES) {
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
