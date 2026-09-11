import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import {
  ensureAttendanceSchema,
  getEmployeeById,
  resolveShiftForEmployee,
  isWeeklyOff,
} from "@/lib/hr-attendance"

// Employee monthly attendance grid — one row per calendar day, merging recorded
// attendance with the Leaves, Holidays and Shift (weekly-off) masters so gaps
// are classified rather than left blank.

function daysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate()
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireFeature("hr.view_attendance")
    if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    await ensureAttendanceSchema()

    const sp = request.nextUrl.searchParams
    const employeeId = Number(sp.get("employeeId"))
    const month = sp.get("month") || "" // YYYY-MM
    const m = month.match(/^(\d{4})-(\d{2})$/)
    if (!employeeId || !m) {
      return NextResponse.json({ error: "employeeId and month (YYYY-MM) are required." }, { status: 400 })
    }
    const year = Number(m[1])
    const monthNum = Number(m[2])
    const start = `${month}-01`
    const end = `${month}-${String(daysInMonth(year, monthNum)).padStart(2, "0")}`

    const employee = await getEmployeeById(employeeId)
    if (!employee) return NextResponse.json({ error: "Employee not found." }, { status: 404 })
    const shift = await resolveShiftForEmployee(employee, start)

    const attendance = await query<any[]>(
      `SELECT * FROM hr_attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ? ORDER BY work_date`,
      [employeeId, start, end],
    )
    const byDate = new Map(attendance.map((r) => [String(r.work_date).slice(0, 10), r]))

    let holidays: any[] = []
    let leaves: any[] = []
    try {
      holidays = await query<any[]>(
        `SELECT holiday_date, holiday_name FROM hr_holidays WHERE holiday_date BETWEEN ? AND ? AND (status='Active' OR status IS NULL)`,
        [start, end],
      )
    } catch {
      holidays = []
    }
    try {
      leaves = await query<any[]>(
        `SELECT from_date, to_date, leave_type_id, days FROM hr_leave_requests
         WHERE employee_id = ? AND status='HR Approved' AND from_date <= ? AND to_date >= ?`,
        [employeeId, end, start],
      )
    } catch {
      leaves = []
    }
    const holidayByDate = new Map(holidays.map((h) => [String(h.holiday_date).slice(0, 10), h.holiday_name]))

    const days: any[] = []
    const totals = { present: 0, absent: 0, leave: 0, holiday: 0, weeklyOff: 0, late: 0, workingHours: 0, overtime: 0 }
    const todayStr = new Date().toISOString().slice(0, 10)

    for (let d = 1; d <= daysInMonth(year, monthNum); d++) {
      const dateStr = `${month}-${String(d).padStart(2, "0")}`
      const rec = byDate.get(dateStr)
      const onLeave = leaves.some((l) => dateStr >= String(l.from_date).slice(0, 10) && dateStr <= String(l.to_date).slice(0, 10))
      const holidayName = holidayByDate.get(dateStr)
      const weeklyOff = isWeeklyOff(shift, dateStr)

      let status: string
      let flags: string[] = []
      let workingHours = 0
      if (rec) {
        status = rec.status
        flags = rec.flags ? String(rec.flags).split(",").filter(Boolean) : []
        workingHours = Number(rec.working_hours || 0)
      } else if (onLeave) {
        status = "On Leave"
      } else if (holidayName) {
        status = "Holiday"
      } else if (weeklyOff) {
        status = "Weekly Off"
      } else if (dateStr > todayStr) {
        status = "Upcoming"
      } else {
        status = "Absent"
      }

      if (status === "Present" || status === "Holiday Worked" || status === "Weekly Off Worked" || status === "Half Day") totals.present++
      else if (status === "Absent") totals.absent++
      else if (status === "On Leave") totals.leave++
      else if (status === "Holiday") totals.holiday++
      else if (status === "Weekly Off") totals.weeklyOff++
      if (rec && Number(rec.late_minutes || 0) > 0) totals.late++
      totals.workingHours += workingHours
      totals.overtime += rec ? Number(rec.overtime_hours || 0) : 0

      days.push({
        date: dateStr,
        status,
        flags,
        clock_in: rec?.clock_in ?? null,
        clock_out: rec?.clock_out ?? null,
        working_hours: workingHours,
        late_minutes: rec ? Number(rec.late_minutes || 0) : 0,
        overtime_hours: rec ? Number(rec.overtime_hours || 0) : 0,
        holiday_name: holidayName ?? null,
        is_manual_override: rec ? Boolean(rec.is_manual_override) : false,
      })
    }

    totals.workingHours = Number(totals.workingHours.toFixed(2))
    totals.overtime = Number(totals.overtime.toFixed(2))

    return NextResponse.json({
      employee: {
        id: employee.id,
        employee_id: employee.employee_id,
        employee_name: employee.employee_name,
        department: employee.department,
        designation: employee.designation,
      },
      month,
      shift: shift ? { shift_name: shift.shift_name, start_time: shift.start_time, end_time: shift.end_time } : null,
      hasShift: Boolean(shift),
      days,
      totals,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load monthly attendance" }, { status: 500 })
  }
}
