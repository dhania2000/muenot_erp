import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureLeaveSchema, listLeaveTypes } from "@/lib/hr-leave"

/** Pickers for the adjustment dialog: employees (management) + active leave types. */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLeaveSchema()

  const canManage =
    session.role === "admin" || (await userHasFeature(session.userId, session.role, "hr.view_leave_balances"))

  const leaveTypes = await listLeaveTypes(true)

  let employees: any[] = []
  if (canManage) {
    employees = await query<any[]>(
      `SELECT id, employee_id, employee_name, department, designation
       FROM hr_employees WHERE archived_at IS NULL ORDER BY employee_name ASC`,
    )
  }

  const currentYear = new Date().getFullYear()
  const years = [currentYear - 1, currentYear, currentYear + 1]

  return NextResponse.json({ canManage, employees, leaveTypes, years })
}
