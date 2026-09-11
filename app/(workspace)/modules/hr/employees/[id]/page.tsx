import { notFound, redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensurePermissionSchema } from "@/lib/permission-store"
import { query } from "@/lib/db"
import { EmployeeProfile } from "@/components/hr/employee-profile"

export default async function EmployeeProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const session = await getSession()
  if (!session) redirect("/login")

  const canView = await userHasFeature(session.userId, session.role, "hr.view_employees")
  if (!canView) redirect("/dashboard")
  const canManage = await userHasFeature(session.userId, session.role, "hr.manage_employees")

  await ensurePermissionSchema()
  const { id } = await params
  const { tab } = await searchParams

  const rows = await query<any[]>(
    `SELECT e.*, u.id AS login_user_id, u.email AS login_email, u.role AS login_role,
            u.status AS login_status, u.must_change_password AS login_must_change
     FROM hr_employees e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.id = ? LIMIT 1`,
    [id],
  )
  const employee = rows[0]
  if (!employee) notFound()

  const linkedUser = employee.login_user_id
    ? {
        id: employee.login_user_id as number,
        email: employee.login_email as string,
        role: employee.login_role as "admin" | "employee",
        status: employee.login_status as string,
        mustChangePassword: Boolean(employee.login_must_change),
      }
    : null

  return (
    <EmployeeProfile
      employee={employee}
      linkedUser={linkedUser}
      isAdmin={session.role === "admin"}
      canManage={canManage}
      defaultTab={tab === "permissions" ? "permissions" : "overview"}
    />
  )
}
