import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureShiftAssignmentSchema, getApplicableShift } from "@/lib/hr-shift-assignments"

async function canView(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, "hr.view_shift_assignments")
}

/**
 * Active employees with NO applicable shift on the date (§31). Rotation
 * membership that resolves to a shift is NOT counted as unassigned. Attendance
 * cannot compute expected hours for these employees, so this is operationally
 * important.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canView(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureShiftAssignmentSchema()

  const sp = new URL(request.url).searchParams
  const onDate = (sp.get("date") || new Date().toISOString().slice(0, 10)).slice(0, 10)

  const employees = await query<any[]>(
    `SELECT id, employee_id, employee_name, department, designation, shift
     FROM hr_employees
     WHERE archived_at IS NULL
       AND (employment_status IS NULL OR LOWER(employment_status) NOT IN
            ('terminated','resigned','exited','inactive','ex-employee','offboarded','left'))
     ORDER BY employee_name LIMIT 5000`,
  )

  const unassigned: any[] = []
  for (const e of employees) {
    const shift = await getApplicableShift({ id: e.id, shift: e.shift }, onDate)
    if (!shift) {
      unassigned.push({
        id: e.id,
        employee_id: e.employee_id,
        employee_name: e.employee_name,
        department: e.department,
        designation: e.designation,
      })
    }
  }

  return NextResponse.json({ date: onDate, count: unassigned.length, employees: unassigned })
}
