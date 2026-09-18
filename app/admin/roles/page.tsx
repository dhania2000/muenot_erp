import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { RolesManager } from "@/components/admin/roles-manager"

export default async function AdminRolesPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  if (session.role !== "admin") redirect("/dashboard")

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Roles &amp; permissions</h1>
        <p className="text-muted-foreground">
          Define custom roles with granular module and action permissions, then assign them to employees.
        </p>
      </header>
      <RolesManager />
    </div>
  )
}
