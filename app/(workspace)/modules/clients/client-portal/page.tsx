import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { PortalAdminConsole } from "@/components/clients/portal-admin/portal-admin-console"

export default async function ClientPortalPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  // Portal admin APIs require the admin role; managing clients gates the UI.
  const canManage = await userHasFeature(session.userId, session.role, "clients.manage_clients")
  if (!canManage || session.role !== "admin") redirect("/modules/clients")

  return (
    <div className="grid gap-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Client Portal</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The control center for the external client portal — clients, applications, access, resources,
          documents, sessions, communications and settings.
        </p>
      </div>
      <PortalAdminConsole />
    </div>
  )
}
