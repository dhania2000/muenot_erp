import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { ensureMessagesSchema } from "@/lib/messages-ensure"
import { getEmployeeProfiles, getMyDepartment } from "@/lib/messages-core"

/**
 * GET /api/messages/recipients
 * Directory used by the "New message / New group / Department" pickers. Reuses
 * the HR Employee Master for department/designation instead of duplicating any
 * employee data. Respects the caller's message_permissions.
 */
export async function GET() {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "messages.view")))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureMessagesSchema()

  const permission =
    (await query<any[]>("SELECT * FROM message_permissions WHERE employee_id=? LIMIT 1", [session.userId]))[0] || null
  const canEmployees = session.role === "admin" || permission?.can_message_employees !== 0
  const canAdmins = session.role === "admin" || permission?.can_message_admins !== 0

  const users = await query<any[]>(
    "SELECT id,name,email,role FROM users WHERE status='active' AND id<>? ORDER BY name",
    [session.userId],
  )
  const profiles = await getEmployeeProfiles(users.map((u) => Number(u.id)))
  const directory = users
    .filter((u) => (u.role === "admin" ? canAdmins : canEmployees))
    .map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      department: profiles.get(Number(u.id))?.department || null,
      designation: profiles.get(Number(u.id))?.designation || null,
    }))

  // Departments the caller can start/join a channel for.
  const deptRows = await query<any[]>(
    "SELECT DISTINCT department FROM hr_employees WHERE department IS NOT NULL AND department<>'' ORDER BY department",
  )
  const myDept = await getMyDepartment(session)
  const departments = deptRows
    .map((d) => d.department)
    .filter((d) => session.role === "admin" || d === myDept)

  return NextResponse.json({
    users: directory,
    departments,
    myDepartment: myDept,
    canCreateGroup: true,
    canCreateManagement: session.role === "admin",
    canAnnounce: session.role === "admin",
  })
}
