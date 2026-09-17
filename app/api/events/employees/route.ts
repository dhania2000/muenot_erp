import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"

// Employee picker for the "Add Participants" dialog. Returns primary keys so
// participants are linked by stable id, not by name.
export async function GET() {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "events.manage")))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const employees = await query<any[]>(
    `SELECT id, employee_id AS employee_ref, employee_name, department, designation, employment_status
       FROM hr_employees
      WHERE employee_name IS NOT NULL AND employee_name <> ''
      ORDER BY employment_status = 'Active' DESC, employee_name`,
  )
  return NextResponse.json({ employees })
}
