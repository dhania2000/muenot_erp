import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getTimeZone, todayInTz } from "@/lib/hr-attendance"
import {
  ensureMonitoringSchema,
  getMonitoringSettings,
  resolveEmployeeForSession,
  todaysAttendance,
  openSessionForAttendance,
  startSession,
  stopSession,
  updateSessionStatus,
  getSessionById,
  logMonitoringAudit,
  type SessionStatus,
} from "@/lib/screen-monitoring"

export const dynamic = "force-dynamic"

/**
 * GET — the employee's monitoring context for today: settings + the current
 * open session (if any) for their active attendance. Powers the client capture
 * engine and the employee "my monitoring" view.
 */
export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    await ensureMonitoringSchema()

    const settings = await getMonitoringSettings()
    const employee = await resolveEmployeeForSession(session)
    if (!employee) {
      return NextResponse.json({ settings: publicSettings(settings), attendance: null, session: null })
    }
    const tz = await getTimeZone()
    const attendance = await todaysAttendance(employee.id, tz)
    const open = attendance ? await openSessionForAttendance(attendance.id) : null

    return NextResponse.json({
      settings: publicSettings(settings),
      employee: { id: employee.id, name: employee.employee_name },
      attendance: attendance
        ? { id: attendance.id, ref: attendance.attendance_id, clockedOut: Boolean(attendance.clock_out) }
        : null,
      session: open,
    })
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 500 })
  }
}

/**
 * POST — start (or reuse) a monitoring session after a Clock In. The browser
 * reports whether screen-share permission was granted; a denial still records a
 * "Permission Denied" session so attendance continues but the status is visible
 * and audited (Phase 1 / Phase 26).
 */
export async function POST(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    await ensureMonitoringSchema()

    const settings = await getMonitoringSettings()
    if (!settings.enabled) {
      return NextResponse.json({ disabled: true, session: null })
    }

    const employee = await resolveEmployeeForSession(session)
    if (!employee) return NextResponse.json({ error: "No employee profile found" }, { status: 400 })

    const body = (await request.json().catch(() => ({}))) as {
      permissionGranted?: boolean
      sourceType?: string
      browser?: string
      os?: string
      deviceId?: string
    }

    const tz = await getTimeZone()
    const attendance = await todaysAttendance(employee.id, tz)
    // Attendance is the source of truth: a session can only start when the
    // employee is currently clocked in (Phase 22).
    if (!attendance || attendance.clock_out) {
      return NextResponse.json({ error: "You must be clocked in to start monitoring." }, { status: 400 })
    }

    const permissionGranted = Boolean(body.permissionGranted)
    const created = await startSession({
      employee,
      userId: session.userId,
      attendanceId: attendance.id,
      attendanceRef: attendance.attendance_id,
      workDate: attendance.work_date?.slice(0, 10) || todayInTz(tz),
      permissionGranted,
      sourceType: body.sourceType ?? null,
      browser: body.browser ?? null,
      os: body.os ?? null,
      deviceId: body.deviceId ?? null,
    })

    await logMonitoringAudit({
      action: permissionGranted ? "monitoring_started" : "permission_denied",
      sessionPk: created.id,
      sessionId: created.session_id,
      employeeId: employee.id,
      userId: session.userId,
      userName: session.name || session.email,
      detail: { browser: body.browser, os: body.os, sourceType: body.sourceType },
    })
    if (permissionGranted) {
      await logMonitoringAudit({
        action: "permission_granted",
        sessionPk: created.id,
        sessionId: created.session_id,
        employeeId: employee.id,
        userId: session.userId,
        userName: session.name || session.email,
      })
    }

    return NextResponse.json({ session: created, settings: publicSettings(settings) })
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 500 })
  }
}

/**
 * PATCH — update an in-progress session: report a permission revocation,
 * pause/resume, or stop it (Clock Out, stream ended, manual stop). Only the
 * owning employee may drive their own live session here.
 */
export async function PATCH(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    await ensureMonitoringSchema()

    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: number
      op?: "stop" | "revoke" | "pause" | "resume"
      reason?: string
    }
    if (!body.sessionId || !body.op) {
      return NextResponse.json({ error: "sessionId and op are required" }, { status: 400 })
    }

    const target = await getSessionById(Number(body.sessionId))
    if (!target) return NextResponse.json({ error: "Session not found" }, { status: 404 })
    // Employees may only control their own session; admins may stop any.
    if (session.role !== "admin" && target.user_id !== session.userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    if (body.op === "revoke") {
      await updateSessionStatus(target.id, { permissionStatus: "Revoked", status: "Paused" })
      const stopped = await stopSession(target.id, {
        reason: "permission_revoked",
        status: "Stopped",
        permissionStatus: "Revoked",
      })
      await logMonitoringAudit({
        action: "permission_revoked",
        sessionPk: target.id,
        sessionId: target.session_id,
        employeeId: target.employee_id,
        userId: session.userId,
        userName: session.name || session.email,
      })
      return NextResponse.json({ session: stopped })
    }

    if (body.op === "pause" || body.op === "resume") {
      const status: SessionStatus = body.op === "pause" ? "Paused" : "Active"
      await updateSessionStatus(target.id, { status })
      return NextResponse.json({ session: await getSessionById(target.id) })
    }

    // op === "stop"
    const stopped = await stopSession(target.id, { reason: body.reason || "clock_out" })
    await logMonitoringAudit({
      action: "monitoring_stopped",
      sessionPk: target.id,
      sessionId: target.session_id,
      employeeId: target.employee_id,
      userId: session.userId,
      userName: session.name || session.email,
      detail: { reason: body.reason || "clock_out" },
    })
    return NextResponse.json({ session: stopped })
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 500 })
  }
}

function publicSettings(s: Awaited<ReturnType<typeof getMonitoringSettings>>) {
  return {
    enabled: s.enabled,
    captureIntervalSeconds: s.capture_interval_seconds,
    imageQuality: s.image_quality,
    maxWidth: s.max_width,
    retentionDays: s.retention_days,
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error"
}
