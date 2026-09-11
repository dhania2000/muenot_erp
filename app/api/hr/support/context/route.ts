import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureSupportSchema, canManageSupport, resolveSessionEmployee, getCategories } from "@/lib/hr-support"

// GET /api/hr/support/context — everything the new-ticket form needs: the
// caller's linked employee, active categories, and a few recent records the
// ticket can optionally be linked to (regularisations, leaves). Agents also get
// the employee directory so they can raise tickets on behalf of staff.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureSupportSchema()

  const manage = await canManageSupport(session)
  const categories = await getCategories()
  const employee = await resolveSessionEmployee(session)

  const employeeSummary = employee
    ? {
        id: employee.id,
        employee_id: employee.employee_id,
        employee_name: employee.employee_name,
        department: employee.department,
        designation: employee.designation,
        reporting_manager: employee.reporting_manager,
        official_email: employee.official_email,
      }
    : null

  // Recent linkable records for the caller's own employee id (best-effort — any
  // table that isn't present just yields an empty list).
  let recentRegularisations: any[] = []
  let recentLeaves: any[] = []
  if (employee) {
    recentRegularisations = await safeQuery(
      "SELECT id, request_id, work_date, status, correction_type FROM hr_attendance_regularisation WHERE employee_id = ? ORDER BY created_at DESC LIMIT 5",
      [employee.id],
    )
    recentLeaves = await safeQuery(
      "SELECT id, leave_id, leave_type, from_date, to_date, status FROM hr_leave_requests WHERE employee_id = ? ORDER BY created_at DESC LIMIT 5",
      [employee.id],
    )
  }

  let employees: any[] = []
  if (manage) {
    employees = await safeQuery(
      "SELECT id, employee_id, employee_name, department FROM hr_employees WHERE employment_status <> 'Exited' ORDER BY employee_name ASC LIMIT 500",
      [],
    )
  }

  return NextResponse.json({
    canManage: manage,
    employee: employeeSummary,
    categories,
    recentRegularisations,
    recentLeaves,
    employees,
  })
}

async function safeQuery(sql: string, params: unknown[]): Promise<any[]> {
  try {
    return await query<any[]>(sql, params)
  } catch {
    return []
  }
}
