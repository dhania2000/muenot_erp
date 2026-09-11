import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureLeaveSchema, listLeaveTypes } from "@/lib/hr-leave"

/** Pickers for the ledger filters and the adjustment dialog. */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()

  const canManage =
    session.role === "admin" || (await userHasFeature(session.userId, session.role, "hr.view_leave_quota_history"))

  const leaveTypes = await listLeaveTypes()

  let employees: any[] = []
  let departments: string[] = []
  if (canManage) {
    employees = await query<any[]>(
      `SELECT id, employee_id, employee_name, department, designation
       FROM hr_employees WHERE archived_at IS NULL ORDER BY employee_name ASC`,
    )
    const deptRows = await query<{ department: string }[]>(
      `SELECT DISTINCT department FROM hr_employees
       WHERE department IS NOT NULL AND department <> '' ORDER BY department`,
    )
    departments = deptRows.map((r) => r.department)
  }

  const yearRows = await query<{ year: number }[]>(
    `SELECT DISTINCT \`year\` AS year FROM hr_leave_quota_history ORDER BY \`year\` DESC`,
  )
  const currentYear = new Date().getFullYear()
  const years = Array.from(new Set([currentYear + 1, currentYear, currentYear - 1, ...yearRows.map((r) => Number(r.year))])).sort(
    (a, b) => b - a,
  )

  return NextResponse.json({ canManage, employees, leaveTypes, departments, years })
}
