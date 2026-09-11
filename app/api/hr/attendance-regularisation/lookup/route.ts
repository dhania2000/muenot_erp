import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { formatHours } from "@/lib/attendance-ui"
import {
  ensureRegularisationSchema,
  canManageRegularisation,
  resolveSessionEmployee,
  buildDayInsight,
} from "@/lib/hr-regularisation"
import { getEmployeeById } from "@/lib/hr-attendance"

// Auto-loads the existing attendance + day context for an employee + work date
// so the form can show CURRENT values and warn about leave/holiday/weekly-off,
// missing attendance, or an existing pending request before submission.
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    await ensureRegularisationSchema()

    const sp = request.nextUrl.searchParams
    const workDate = String(sp.get("work_date") || "").slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
      return NextResponse.json({ error: "A valid work date is required." }, { status: 400 })
    }

    const canManage = await canManageRegularisation(session)
    let employee
    if (canManage && sp.get("employee_id")) {
      employee = await getEmployeeById(Number(sp.get("employee_id")))
    } else {
      employee = await resolveSessionEmployee(session)
    }
    if (!employee) return NextResponse.json({ error: "No employee profile is linked to this account." }, { status: 400 })

    const insight = await buildDayInsight(employee, workDate)

    // Prior regularisation history for the same employee + date (traceability).
    const history = await query<any[]>(
      `SELECT request_id, correction_type, current_clock_in, current_clock_out,
              requested_clock_in, requested_clock_out, status, reviewed_by, reviewed_at
       FROM hr_attendance_regularisation
       WHERE employee_id = ? AND work_date = ?
       ORDER BY id DESC LIMIT 10`,
      [employee.id, workDate],
    )

    return NextResponse.json({
      employee: {
        id: employee.id,
        employee_id: employee.employee_id,
        employee_name: employee.employee_name,
        department: employee.department,
        designation: employee.designation,
        reporting_manager: employee.reporting_manager,
        employment_status: employee.employment_status,
      },
      shift: insight.shift
        ? { name: insight.shift.shift_name, start: insight.shift.start_time, end: insight.shift.end_time, isOvernight: insight.shift.is_overnight }
        : null,
      attendance: insight.attendance
        ? { ...insight.attendance, workedHuman: formatHours(insight.attendance.working_hours) }
        : null,
      dayContext: insight.dayContext,
      suggestedType: insight.suggestedType,
      pendingExists: insight.pendingExists,
      blocked: insight.blocked,
      canManage,
      history,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load attendance" }, { status: 500 })
  }
}
