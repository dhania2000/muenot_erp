import { query } from "@/lib/db"
import { getAllModulesWithFeatures } from "@/lib/permissions"
import { EmployeesTable, type EmployeeRow } from "@/components/admin/employees-table"

export default async function AdminEmployeesPage() {
  const [employees, modules] = await Promise.all([
    query<EmployeeRow[]>(
      `SELECT id, name, email, role, designation, status, must_change_password, created_at
       FROM users ORDER BY created_at DESC`,
    ),
    getAllModulesWithFeatures(),
  ])

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
        <p className="text-sm text-muted-foreground">
          Invite employees and control exactly which features they can access in each module.
        </p>
      </div>

      <EmployeesTable initialEmployees={employees} modules={modules} />
    </div>
  )
}
