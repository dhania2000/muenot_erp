import { query } from "@/lib/db"
import { AdminDashboard } from "@/components/admin/admin-dashboard"


export default async function AdminOverviewPage() {
  const employeeCountRows = await query<{ total: number; active: number }[]>(
    `SELECT COUNT(*) as total, SUM(status = 'active') as active FROM users WHERE role = 'employee'`,
  )
  const employeeCount = employeeCountRows[0] || { total: 0, active: 0 }
  return <AdminDashboard employeeTotal={Number(employeeCount.total)} employeeActive={Number(employeeCount.active || 0)} />
}
