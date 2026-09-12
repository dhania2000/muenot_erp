import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureShiftAssignmentSchema } from "@/lib/hr-shift-assignments"

async function canView(session: { userId: number; role: "admin" | "employee" }) {
  if (session.role === "admin") return true
  return userHasFeature(session.userId, session.role, "hr.view_shift_assignments")
}

/**
 * Controlled inconsistency report (§32). Surfaces data already present in
 * legacy rows rather than silently ignoring it:
 *   • overlapping active assignments to different shifts for the same employee
 *   • active assignments pointing at an inactive shift
 *   • invalid date ranges (effective_to before effective_from)
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canView(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureShiftAssignmentSchema()

  // Overlapping active assignments to a different shift for the same employee.
  const overlapping = await query<any[]>(
    `SELECT a.assignment_id AS a_id, b.assignment_id AS b_id, a.employee_id,
            e.employee_name, e.employee_id AS employee_code,
            sa.shift_name AS a_shift, sb.shift_name AS b_shift,
            a.effective_from AS a_from, a.effective_to AS a_to,
            b.effective_from AS b_from, b.effective_to AS b_to
     FROM hr_shift_assignments a
     JOIN hr_shift_assignments b
       ON a.employee_id = b.employee_id AND a.id < b.id
      AND a.status = 'Active' AND b.status = 'Active'
      AND a.shift_id <> b.shift_id
      AND a.effective_from <= COALESCE(b.effective_to, '9999-12-31')
      AND b.effective_from <= COALESCE(a.effective_to, '9999-12-31')
     LEFT JOIN hr_employees e ON e.id = a.employee_id
     LEFT JOIN hr_shifts sa ON sa.id = a.shift_id
     LEFT JOIN hr_shifts sb ON sb.id = b.shift_id
     ORDER BY a.employee_id LIMIT 500`,
  )

  const inactiveShift = await query<any[]>(
    `SELECT a.assignment_id, a.employee_id, e.employee_name, e.employee_id AS employee_code,
            s.shift_name, a.effective_from, a.effective_to
     FROM hr_shift_assignments a
     LEFT JOIN hr_employees e ON e.id = a.employee_id
     JOIN hr_shifts s ON s.id = a.shift_id
     WHERE a.status = 'Active' AND s.status = 'Inactive'
       AND (a.effective_to IS NULL OR a.effective_to >= CURDATE())
     ORDER BY a.employee_id LIMIT 500`,
  )

  const invalidRange = await query<any[]>(
    `SELECT a.assignment_id, a.employee_id, e.employee_name, e.employee_id AS employee_code,
            s.shift_name, a.effective_from, a.effective_to
     FROM hr_shift_assignments a
     LEFT JOIN hr_employees e ON e.id = a.employee_id
     LEFT JOIN hr_shifts s ON s.id = a.shift_id
     WHERE a.effective_to IS NOT NULL AND a.effective_to < a.effective_from
     ORDER BY a.employee_id LIMIT 500`,
  )

  return NextResponse.json({
    overlapping,
    inactiveShift,
    invalidRange,
    total: overlapping.length + inactiveShift.length + invalidRange.length,
  })
}
