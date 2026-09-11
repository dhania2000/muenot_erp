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
  // table that isn't present just yields an empty list). Column names are kept
  // in sync with the actual HR module schemas so linking never silently breaks.
  let recentRegularisations: any[] = []
  let recentLeaves: any[] = []
  let recentAttendance: any[] = []
  let recentDocuments: any[] = []
  if (employee) {
    recentRegularisations = await safeQuery(
      "SELECT id, request_id, work_date, status FROM hr_attendance_regularisation WHERE employee_id = ? ORDER BY id DESC LIMIT 8",
      [employee.id],
    )
    recentLeaves = await safeQuery(
      `SELECT lr.id, lr.request_id, lt.leave_type AS leave_type_name, lr.from_date, lr.to_date, lr.status
       FROM hr_leave_requests lr LEFT JOIN hr_leave_types lt ON lt.leave_type_id = lr.leave_type_id
       WHERE lr.employee_id = ? ORDER BY lr.id DESC LIMIT 8`,
      [employee.id],
    )
    recentAttendance = await safeQuery(
      "SELECT id, attendance_id, work_date, status, working_hours FROM hr_attendance WHERE employee_id = ? ORDER BY work_date DESC LIMIT 8",
      [employee.id],
    )
    recentDocuments = await safeQuery(
      "SELECT id, document_ref, document_type, status FROM hr_employee_documents WHERE employee_id = ? AND (is_current = 1 OR is_current IS NULL) ORDER BY id DESC LIMIT 8",
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
    recentAttendance,
    recentDocuments,
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
