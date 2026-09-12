import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import {
  ensureShiftAssignmentSchema,
  listActiveShifts,
  getEmployee,
  getEmployeeByEmail,
  getApplicableShift,
  getUpcomingAssignment,
  detectAssignmentConflicts,
} from "@/lib/hr-shift-assignments"

async function canManage(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, "hr.manage_shift_assignments")
}

/**
 * Backs the domain assignment form. Never asks the user for data the ERP knows:
 *   • Active Shift Master list for the "New Shift" selector.
 *   • Employee directory for the HR/Admin selector.
 *   • ?employee_id (+ ?date) → that employee's derived context (current shift,
 *     upcoming assignment, profile facts) — all computed server-side.
 *   • ?shift_id → live conflict preview for the candidate shift/date range.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftAssignmentSchema()

  const sp = new URL(request.url).searchParams
  const manage = await canManage(session)
  const onDate = (sp.get("date") || new Date().toISOString().slice(0, 10)).slice(0, 10)

  const shifts = await listActiveShifts()

  // Which employee are we building context for?
  let employee = null as Awaited<ReturnType<typeof getEmployee>>
  const requestedId = sp.get("employee_id")
  if (requestedId && manage) employee = await getEmployee(Number(requestedId))
  else employee = await getEmployeeByEmail(session.email)

  let employees: any[] = []
  if (manage) {
    employees = await query<any[]>(
      `SELECT id, employee_id, employee_name, department, designation, employment_status
       FROM hr_employees WHERE archived_at IS NULL ORDER BY employee_name LIMIT 2000`,
    )
  }

  let context = null
  if (employee) {
    const currentShift = await getApplicableShift(employee, onDate)
    const upcoming = await getUpcomingAssignment(employee.id, onDate)
    context = {
      employee: {
        id: employee.id,
        employee_id: employee.employee_id,
        employee_name: employee.employee_name,
        department: employee.department,
        designation: employee.designation,
        reporting_manager: employee.reporting_manager,
        employment_status: employee.employment_status,
      },
      currentShift: currentShift
        ? {
            id: currentShift.id,
            shift_id: currentShift.shift_id,
            shift_name: currentShift.shift_name,
            start_time: currentShift.start_time,
            end_time: currentShift.end_time,
            is_overnight: currentShift.is_overnight,
            break_minutes: currentShift.break_minutes,
            working_hours: currentShift.working_hours,
            overtime_enabled: currentShift.overtime_enabled,
          }
        : null,
      upcoming: upcoming
        ? {
            assignment_id: upcoming.assignment_id,
            shift_name: upcoming.shift_name,
            effective_from: upcoming.effective_from,
            effective_to: upcoming.effective_to,
          }
        : null,
    }
  }

  // Live conflict preview for a candidate shift/date range.
  let conflicts = null
  const candidate = sp.get("shift_id")
  if (employee && candidate) {
    conflicts = await detectAssignmentConflicts({
      employeeId: employee.id,
      employeeShift: employee.shift,
      shiftId: Number(candidate),
      changeType: sp.get("change_type") === "Temporary" ? "Temporary" : "Permanent",
      fromDate: onDate,
      toDate: sp.get("to_date") || null,
    })
  }

  return NextResponse.json({ canManage: manage, shifts, employees, context, conflicts })
}
