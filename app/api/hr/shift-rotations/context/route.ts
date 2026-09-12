import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import {
  ensureShiftRotationSchema,
  listActiveShifts,
  listAssignableEmployees,
  listDepartments,
} from "@/lib/hr-shift-rotations"

/**
 * Feeds the rotation builder + membership forms. Never asks the user for data
 * the ERP already owns: the Active Shift Master list, the employee directory
 * and the distinct department list (for bulk assignment).
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftRotationSchema()

  const manage = session.role === "admin" || (await userHasFeature(session.userId, session.role, "hr.manage_shift_rotations"))

  const [shifts, employees, departments] = await Promise.all([
    listActiveShifts(),
    manage ? listAssignableEmployees() : Promise.resolve([]),
    manage ? listDepartments() : Promise.resolve([]),
  ])

  return NextResponse.json({ canManage: manage, shifts, employees, departments })
}
