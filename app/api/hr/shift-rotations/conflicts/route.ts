import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { ensureShiftRotationSchema } from "@/lib/hr-shift-rotations"

/**
 * ERP-wide rotation health check. Surfaces:
 *   • employees whose ACTIVE membership windows overlap across two rotations
 *     (ambiguous rotation — the resolver keeps latest start, but it should be
 *     resolved by HR),
 *   • active memberships pointing at a rotation that is now inactive,
 *   • rotations whose pattern references an inactive/deleted shift.
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftRotationSchema()
  const allowed =
    session.role === "admin" ||
    (await userHasFeature(session.userId, session.role, "hr.view_shift_rotations")) ||
    (await userHasFeature(session.userId, session.role, "hr.manage_shift_rotations"))
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  // Overlapping active memberships across different rotations.
  const overlapping = await query<any[]>(
    `SELECT a.record_id AS a_id, b.record_id AS b_id, e.employee_name, e.employee_id AS employee_code,
            ra.rotation_id AS a_rotation, rb.rotation_id AS b_rotation
     FROM hr_shift_rotation_employees a
     JOIN hr_shift_rotation_employees b
       ON a.employee_id = b.employee_id AND a.rotation_id < b.rotation_id
     JOIN hr_shift_rotations ra ON ra.id = a.rotation_id
     JOIN hr_shift_rotations rb ON rb.id = b.rotation_id
     JOIN hr_employees e ON e.id = a.employee_id
     WHERE a.status = 'Active' AND b.status = 'Active'
       AND a.start_date <= COALESCE(b.end_date, '9999-12-31')
       AND b.start_date <= COALESCE(a.end_date, '9999-12-31')
     ORDER BY e.employee_name LIMIT 500`,
  )

  const orphanMembership = await query<any[]>(
    `SELECT re.record_id, e.employee_name, e.employee_id AS employee_code, r.rotation_id, r.rotation_name
     FROM hr_shift_rotation_employees re
     JOIN hr_shift_rotations r ON r.id = re.rotation_id
     JOIN hr_employees e ON e.id = re.employee_id
     WHERE re.status = 'Active' AND r.status = 'Inactive'
     ORDER BY e.employee_name LIMIT 500`,
  )

  const inactiveShift = await query<any[]>(
    `SELECT DISTINCT r.rotation_id, r.rotation_name, sh.shift_name
     FROM hr_shift_rotation_sequences s
     JOIN hr_shift_rotations r ON r.id = s.rotation_id
     JOIN hr_shifts sh ON sh.id = s.shift_id
     WHERE r.status = 'Active' AND s.is_weekly_off = 0 AND sh.status IS NOT NULL AND sh.status <> 'Active'
     ORDER BY r.rotation_name LIMIT 500`,
  )

  const total = overlapping.length + orphanMembership.length + inactiveShift.length
  return NextResponse.json({ total, overlapping, orphanMembership, inactiveShift })
}
