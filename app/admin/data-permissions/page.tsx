import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { DataScopeManager } from "@/components/admin/data-scope-manager"

export default async function DataPermissionsPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  if (session.role !== "admin") redirect("/dashboard")

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Data permissions</h1>
        <p className="text-muted-foreground">
          Control record-level visibility per user. Choose what each person can see for every sensitive data domain —
          only their own records, their team, their assigned entities, their branches, or everything.
        </p>
      </header>

      <DataScopeManager />
    </div>
  )
}
