import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { nextRecordId } from "@/lib/record-ids"
import { logEmployeeEvent } from "@/lib/hr-employee-events"
import {
  ensureAttendanceSchema,
  getEmployeeById,
  resolveShiftForEmployee,
  resolveDayContext,
  computeAttendanceMetrics,
  getTimeZone,
} from "@/lib/hr-attendance"

// ---------------------------------------------------------------------------
// Attendance list + admin manual entry + admin override.
//   GET   — filtered, paginated, enriched list + live summary aggregation.
//   POST  — HR/Admin manual entry (employee picked from master, auto ID, auto calc).
//   PATCH — HR/Admin override of an existing record (reason required, audited).
// All reads/writes reuse the Employees, Shifts, Leaves and Holidays masters.
// ---------------------------------------------------------------------------

/** Normalise a clock value to a MySQL DATETIME anchored on the work date. */
function toDateTime(workDate: string, value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return null
  const text = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text)) return text.replace("T", " ").slice(0, 19)
  if (/^\d{1,2}:\d{2}/.test(text)) return `${workDate} ${text.length === 4 ? "0" + text : text}:00`.slice(0, 19)
  return text
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireFeature("hr.view_attendance")
    if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    await ensureAttendanceSchema()

    const sp = request.nextUrl.searchParams
    const page = Math.max(1, Number(sp.get("page") || 1))
    const pageSize = Math.min(200, Math.max(1, Number(sp.get("pageSize") || 25)))
    const offset = (page - 1) * pageSize

    const where: string[] = []
    const params: unknown[] = []
    const add = (clause: string, ...values: unknown[]) => {
      where.push(clause)
      params.push(...values)
    }

    const from = sp.get("from")
    const to = sp.get("to")
    if (from) add("a.work_date >= ?", from)
    if (to) add("a.work_date <= ?", to)
    if (sp.get("employeeId")) add("a.employee_id = ?", Number(sp.get("employeeId")))
    if (sp.get("department")) add("e.department = ?", sp.get("department"))
    if (sp.get("designation")) add("e.designation = ?", sp.get("designation"))
    if (sp.get("manager")) add("e.reporting_manager = ?", sp.get("manager"))
    if (sp.get("status")) add("a.status = ?", sp.get("status"))
    if (sp.get("source")) add("a.source = ?", sp.get("source"))
    if (sp.get("late") === "1") add("a.late_minutes > 0")
    if (sp.get("early") === "1") add("a.early_leaving_minutes > 0")
    if (sp.get("overtime") === "1") add("a.overtime_hours > 0")
    if (sp.get("missed") === "1") add("a.status = 'Missed Checkout'")
    const search = sp.get("search")?.trim()
    if (search) add("(a.employee_name LIKE ? OR e.employee_id LIKE ? OR a.attendance_id LIKE ?)", `%${search}%`, `%${search}%`, `%${search}%`)

    // Latest relevant regularisation for the same employee + date (Pending first).
    // Guard against the table being absent (missed migration): fall back to a
    // constant NULL so the attendance list still loads instead of 500-ing.
    const regTable = await query<{ c: number }[]>(
      "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'hr_attendance_regularisation'",
    ).catch(() => [{ c: 0 }])
    const hasRegTable = Number(regTable[0]?.c || 0) > 0
    const regExpr = hasRegTable
      ? `(SELECT r.status FROM hr_attendance_regularisation r
        WHERE r.employee_id = a.employee_id AND r.work_date = a.work_date
        ORDER BY FIELD(r.status,'Pending','Approved','Rejected'), r.id DESC LIMIT 1)`
      : `(NULL)`

    if (sp.get("regularisation") === "pending") add(`${regExpr} = 'Pending'`)
    if (sp.get("regularisation") === "regularised") add(`${regExpr} = 'Approved'`)

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

    const rows = await query<any[]>(
      `SELECT a.*, e.employee_id AS employee_code, e.department, e.designation, e.reporting_manager,
              e.employment_status, ${regExpr} AS regularisation_status
       FROM hr_attendance a
       JOIN hr_employees e ON e.id = a.employee_id
       ${whereSql}
       ORDER BY a.work_date DESC, a.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    )

    const countRows = await query<any[]>(
      `SELECT COUNT(*) AS total FROM hr_attendance a JOIN hr_employees e ON e.id = a.employee_id ${whereSql}`,
      params,
    )
    const total = Number(countRows[0]?.total || 0)

    const summaryRows = await query<any[]>(
      `SELECT
         COUNT(*) AS records,
         SUM(a.status = 'Present') AS present,
         SUM(a.status = 'Absent') AS absent,
         SUM(a.status = 'On Leave') AS on_leave,
         SUM(a.late_minutes > 0) AS late,
         SUM(a.early_leaving_minutes > 0) AS early,
         SUM(a.status = 'Half Day') AS half_day,
         SUM(a.status = 'Missed Checkout') AS missed_checkout,
         SUM(a.overtime_hours > 0) AS overtime,
         SUM(a.status IN ('Holiday','Weekly Off','Holiday Worked','Weekly Off Worked')) AS holiday_off,
         SUM(${regExpr} = 'Pending') AS regularisation_pending
       FROM hr_attendance a JOIN hr_employees e ON e.id = a.employee_id ${whereSql}`,
      params,
    )
    const s = summaryRows[0] || {}
    const summary = {
      records: Number(s.records || 0),
      present: Number(s.present || 0),
      absent: Number(s.absent || 0),
      onLeave: Number(s.on_leave || 0),
      late: Number(s.late || 0),
      early: Number(s.early || 0),
      halfDay: Number(s.half_day || 0),
      missedCheckout: Number(s.missed_checkout || 0),
      overtime: Number(s.overtime || 0),
      holidayOff: Number(s.holiday_off || 0),
      regularisationPending: Number(s.regularisation_pending || 0),
    }

    const totalEmployees = Number(
      (await query<any[]>("SELECT COUNT(*) AS c FROM hr_employees WHERE archived_at IS NULL"))[0]?.c || 0,
    )

    return NextResponse.json({
      attendance: rows.map((r) => ({ ...r, flags: r.flags ? String(r.flags).split(",").filter(Boolean) : [] })),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      summary: { ...summary, totalEmployees },
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load attendance" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireFeature("hr.manage_attendance")
    if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    await ensureAttendanceSchema()

    const body = await request.json().catch(() => ({}))
    const employeeId = Number(body.employee_id)
    const workDate = String(body.work_date || "").slice(0, 10)
    if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
      return NextResponse.json({ error: "Employee and a valid work date are required." }, { status: 400 })
    }

    const employee = await getEmployeeById(employeeId)
    if (!employee) return NextResponse.json({ error: "Selected employee does not exist." }, { status: 400 })

    const clockIn = toDateTime(workDate, body.clock_in)
    const clockOut = toDateTime(workDate, body.clock_out)
    if (clockIn && clockOut && new Date(clockOut) < new Date(clockIn)) {
      return NextResponse.json({ error: "Clock out cannot be before clock in." }, { status: 400 })
    }
    const breakMinutes = Number(body.break_minutes || 0)

    const shift = await resolveShiftForEmployee(employee, workDate)
    const dayContext = await resolveDayContext(employeeId, workDate, shift)
    const metrics = computeAttendanceMetrics({ shift, clockIn, clockOut, breakMinutes, dayContext })
    // Admin may explicitly set a status; otherwise the engine's value is used.
    const status = body.status ? String(body.status) : metrics.status

    const attendanceId = await nextRecordId("ATT", { allowCustom: true, digits: 6 })

    try {
      await query(
        `INSERT INTO hr_attendance
           (attendance_id, employee_id, employee_name, work_date, clock_in, clock_out, break_minutes,
            working_hours, status, late_minutes, early_leaving_minutes, overtime_hours, source, remarks,
            flags, day_type, leave_request_id, is_manual_override, override_reason, created_by, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          attendanceId,
          employeeId,
          employee.employee_name,
          workDate,
          clockIn,
          clockOut,
          breakMinutes,
          metrics.workingHours,
          status,
          metrics.lateMinutes,
          metrics.earlyLeavingMinutes,
          metrics.overtimeHours,
          "Admin Manual",
          body.remarks ? String(body.remarks).slice(0, 1000) : null,
          metrics.flags.join(","),
          dayContext.dayType,
          dayContext.leaveRequestId,
          1,
          body.remarks ? String(body.remarks).slice(0, 500) : "Manual entry",
          session.userId,
          session.userId,
        ],
      )
    } catch (e) {
      if (String((e as Error).message).includes("Duplicate")) {
        return NextResponse.json({ error: "An attendance record already exists for this employee and date." }, { status: 409 })
      }
      throw e
    }

    await logEmployeeEvent({
      employeeId,
      employeeRef: employee.employee_id,
      employeeName: employee.employee_name,
      type: "updated",
      summary: `Manual attendance ${attendanceId} created for ${workDate} (${status})`,
      actorId: session.userId,
      actorName: session.name,
    })

    return NextResponse.json({ ok: true, attendance_id: attendanceId, status, metrics }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save attendance" }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireFeature("hr.manage_attendance")
    if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    await ensureAttendanceSchema()

    const body = await request.json().catch(() => ({}))
    const id = Number(body.id)
    const reason = String(body.reason || "").trim()
    if (!id) return NextResponse.json({ error: "Attendance record id is required." }, { status: 400 })
    if (!reason) return NextResponse.json({ error: "A reason is required for an override." }, { status: 400 })

    const existingRows = await query<any[]>("SELECT * FROM hr_attendance WHERE id = ? LIMIT 1", [id])
    const existing = existingRows[0]
    if (!existing) return NextResponse.json({ error: "Attendance record not found." }, { status: 404 })

    const workDate = String(existing.work_date).slice(0, 10)
    const employee = await getEmployeeById(Number(existing.employee_id))
    const clockIn = "clock_in" in body ? toDateTime(workDate, body.clock_in) : existing.clock_in
    const clockOut = "clock_out" in body ? toDateTime(workDate, body.clock_out) : existing.clock_out
    const breakMinutes = "break_minutes" in body ? Number(body.break_minutes || 0) : Number(existing.break_minutes || 0)

    const shift = employee ? await resolveShiftForEmployee(employee, workDate) : null
    const dayContext = await resolveDayContext(Number(existing.employee_id), workDate, shift)
    const metrics = computeAttendanceMetrics({ shift, clockIn, clockOut, breakMinutes, dayContext })
    const status = body.status ? String(body.status) : metrics.status

    const changes: { field: string; label: string; from: unknown; to: unknown }[] = []
    const track = (field: string, label: string, before: unknown, after: unknown) => {
      if (String(before ?? "") !== String(after ?? "")) changes.push({ field, label, from: before ?? null, to: after ?? null })
    }
    track("clock_in", "Clock in", existing.clock_in, clockIn)
    track("clock_out", "Clock out", existing.clock_out, clockOut)
    track("status", "Status", existing.status, status)
    track("break_minutes", "Break minutes", existing.break_minutes, breakMinutes)

    await query(
      `UPDATE hr_attendance SET clock_in = ?, clock_out = ?, break_minutes = ?, working_hours = ?, status = ?,
         late_minutes = ?, early_leaving_minutes = ?, overtime_hours = ?, flags = ?, day_type = ?,
         is_manual_override = 1, override_reason = ?, updated_by = ? WHERE id = ?`,
      [
        clockIn,
        clockOut,
        breakMinutes,
        metrics.workingHours,
        status,
        metrics.lateMinutes,
        metrics.earlyLeavingMinutes,
        metrics.overtimeHours,
        metrics.flags.join(","),
        dayContext.dayType,
        reason.slice(0, 500),
        session.userId,
        id,
      ],
    )

    await logEmployeeEvent({
      employeeId: Number(existing.employee_id),
      employeeRef: employee?.employee_id ?? null,
      employeeName: existing.employee_name,
      type: "updated",
      summary: `Attendance ${existing.attendance_id} overridden for ${workDate}: ${reason}`,
      changes: changes.length ? changes : null,
      actorId: session.userId,
      actorName: session.name,
    })

    return NextResponse.json({ ok: true, status, metrics })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to override attendance" }, { status: 500 })
  }
}
