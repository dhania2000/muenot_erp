import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import {
  ensureShiftChangeSchema,
  getEmployeeByEmailFull,
  getEmployeeFull,
  listActiveShifts,
  resolveCurrentShift,
  resolveRotationShift,
  getShiftDetail,
  detectConflicts,
} from "@/lib/hr-shift-change"

async function resolvePrivilege(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, "hr.view_shift_change_requests")
}

/**
 * Backs the new-request form and the approver preview. Never asks the user for
 * data the ERP already knows — everything below is derived server-side:
 *   • ?employee_id + ?date → that employee's context (managers/admins only)
 *   • otherwise            → the caller's own self-service context
 * Always returns the active Shift Master list for the requested-shift selector.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftChangeSchema()

  const sp = new URL(request.url).searchParams
  const canManage = await resolvePrivilege(session)
  const onDate = (sp.get("date") || new Date().toISOString().slice(0, 10)).slice(0, 10)

  const shifts = await listActiveShifts()

  // Resolve which employee we are building context for.
  let employee = null as Awaited<ReturnType<typeof getEmployeeFull>>
  const requestedEmployeeId = sp.get("employee_id")
  if (requestedEmployeeId && canManage) {
    employee = await getEmployeeFull(Number(requestedEmployeeId))
  } else {
    employee = await getEmployeeByEmailFull(session.email)
  }

  // Employee directory for the HR/Admin selector.
  let employees: any[] = []
  if (canManage) {
    employees = await query<any[]>(
      `SELECT id, employee_id, employee_name, department, designation, employment_status
       FROM hr_employees
       WHERE archived_at IS NULL
       ORDER BY employee_name LIMIT 1000`,
    )
  }

  let context = null
  if (employee) {
    const currentShift = await resolveCurrentShift(employee, onDate)
    const rotation = await resolveRotationShift(employee.id, onDate)
    const rotationShift = rotation ? await getShiftDetail(rotation.shiftId) : null
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
      currentShift,
      rotation: rotation ? { name: rotation.rotationName, shift: rotationShift?.shift_name || null } : null,
    }
  }

  // Optional live preview conflicts for a candidate shift/date range.
  let conflicts = null
  const candidateShift = sp.get("requested_shift_id")
  if (employee && candidateShift) {
    conflicts = await detectConflicts({
      employeeId: employee.id,
      employeeShift: employee.shift,
      fromDate: onDate,
      toDate: sp.get("to_date") || null,
      requestedShiftId: Number(candidateShift),
    })
  }

  return NextResponse.json({ canManage, shifts, employees, context, conflicts })
}
