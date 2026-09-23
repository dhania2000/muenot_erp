import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureAttendanceSchema } from "@/lib/hr-attendance"
import { resolveTenantIdForUser } from "@/lib/tenant-service"
import { upsertIdleSession } from "@/lib/attendance-idle-sessions"

// ---------------------------------------------------------------------------
// Non-work time reporting for the currently clocked-in employee.
//
// The browser reports a stable sessionId with start/end timestamps for each
// continuous inactivity stretch. Heartbeats and final reports are idempotent;
// the clock route applies the shared grace threshold to each stretch.
// Legacy minute reports and the separate screen-missing source remain accepted
// for compatibility with older clients. Reports attach to the current OPEN row,
// including an overnight shift.
// ---------------------------------------------------------------------------

/** Reports below this (minutes) are noise and ignored — the client pre-graces. */
const MIN_REPORT_MINUTES = 1
/** Defensive cap so a single report can never poison the row. */
const MAX_SINGLE_REPORT_MINUTES = 16 * 60

export async function POST(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    await ensureAttendanceSchema()

    let body: { minutes?: unknown; type?: unknown; sessionId?: unknown; startAt?: unknown; endAt?: unknown; ended?: unknown } = {}
    try {
      body = await request.json()
    } catch {
      // ignore — validated below
    }
    const isSessionReport = body.type !== "screen-missing" && body.sessionId !== undefined
    const minutes = Number(body.minutes)
    if (!isSessionReport && (!Number.isFinite(minutes) || minutes < MIN_REPORT_MINUTES)) {
      return NextResponse.json({ ok: true, skipped: true })
    }
    const capped = Math.min(Math.round(minutes), MAX_SINGLE_REPORT_MINUTES)
    // Screen-missing time goes to its own no-grace column; everything else is idle.
    const isScreenMissing = body.type === "screen-missing"

    // Resolve the employee linked to this session's login email.
    const tenantId = await resolveTenantIdForUser(session.userId)
    if (!tenantId) return NextResponse.json({ error: "Tenant unavailable" }, { status: 403 })
    const emp = await query<{ id: number }[]>(
      "SELECT id FROM hr_employees WHERE official_email = ? OR personal_email = ? ORDER BY id LIMIT 1",
      [session.email, session.email],
    )
    if (!emp[0]) return NextResponse.json({ ok: true, skipped: true })

    // A shift opened yesterday remains the active attendance row after midnight.
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
          "SELECT id, clock_in, clock_out, active_since, idle_minutes, screen_missing_minutes FROM hr_attendance WHERE employee_id = ? AND clock_in IS NOT NULL AND clock_out IS NULL ORDER BY work_date DESC LIMIT 1",
          [emp[0].id],
        )
      )[0]
    } catch {
      row = (
        await query<Row[]>(
          "SELECT id, clock_in, clock_out, idle_minutes FROM hr_attendance WHERE employee_id = ? AND clock_in IS NOT NULL AND clock_out IS NULL ORDER BY work_date DESC LIMIT 1",
          [emp[0].id],
        )
      )[0]
    }
    if (!row) return NextResponse.json({ ok: true, skipped: true })

    // Only accrue against an OPEN session (either a live session marker, or a
    // clock-in with no clock-out yet).
    const open = row.active_since ? true : Boolean(row.clock_in && !row.clock_out)
    if (!open) return NextResponse.json({ ok: true, skipped: true })

    if (isSessionReport) {
      const sessionKey = typeof body.sessionId === "string" ? body.sessionId : ""
      const startMs = typeof body.startAt === "string" ? Date.parse(body.startAt) : NaN
      const endMs = typeof body.endAt === "string" ? Date.parse(body.endAt) : NaN
      const now = Date.now()
      if (!/^[0-9a-f-]{36}$/i.test(sessionKey) || !Number.isFinite(startMs) || !Number.isFinite(endMs)
        || endMs < startMs || endMs > now + 5_000 || startMs < now - MAX_SINGLE_REPORT_MINUTES * 60_000
        || endMs - startMs > MAX_SINGLE_REPORT_MINUTES * 60_000 || typeof body.ended !== "boolean") {
        return NextResponse.json({ error: "Invalid idle session interval" }, { status: 400 })
      }
      const totals = await upsertIdleSession({ tenantId, attendanceRowId: row.id, employeeId: emp[0].id,
        sessionKey, startMs, endMs, ended: body.ended })
      if (!totals) return NextResponse.json({ ok: true, skipped: true })
      return NextResponse.json({ ok: true, idleSeconds: totals.idleSeconds, breakSeconds: totals.breakSeconds })
    }

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
