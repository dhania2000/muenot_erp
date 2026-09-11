import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import {
  ensureLeaveSchema,
  getEmployeeByEmail,
  getEmployeeById,
  deriveManager,
  listLeaveTypes,
  getBalanceSnapshot,
} from "@/lib/hr-leave"

/**
 * Auto-context for the Apply dialog: who is applying, their manager, the active
 * leave types, and their current balances for the target year.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()

  const canManage = session.role === "admin" || (await userHasFeature(session.userId, session.role, "hr.view_leave_requests"))
  const sp = new URL(request.url).searchParams
  const year = Number(sp.get("year")) || new Date().getFullYear()

  // Privileged users may apply on behalf of a chosen employee.
  const requested = sp.get("employee_id")
  let employee = null
  if (canManage && requested) {
    employee = await getEmployeeById(requested)
  } else {
    employee = await getEmployeeByEmail(session.email)
  }

  const leaveTypes = await listLeaveTypes(true)
  const manager = await deriveManager(employee)

  const balances: Record<string, any> = {}
  if (employee) {
    for (const type of leaveTypes) {
      const snapshot = await getBalanceSnapshot(employee.id, type, year)
      balances[type.leave_type_id] = {
        opening: Number(snapshot.opening),
        accrued: Number(snapshot.accrued),
        used: Number(snapshot.used),
        pending: Number(snapshot.pending),
        adjusted: Number(snapshot.adjusted),
        available: Number(snapshot.available),
      }
    }
  }

  // Privileged users get the employee dropdown for on-behalf applications.
  let employees: any[] = []
  if (canManage) {
    employees = await query<any[]>(
      `SELECT id, employee_id, employee_name, department, designation
       FROM hr_employees WHERE archived_at IS NULL ORDER BY employee_name ASC`,
    )
  }

  return NextResponse.json({
    canManage,
    year,
    employee: employee
      ? {
          id: employee.id,
          employee_id: employee.employee_id,
          employee_name: employee.employee_name,
          department: employee.department,
          designation: employee.designation,
          gender: employee.gender,
          employment_type: employee.employment_type,
          reporting_manager: employee.reporting_manager,
        }
      : null,
    manager: manager ? { id: manager.id, name: manager.employee_name } : null,
    leaveTypes,
    balances,
    employees,
  })
}
