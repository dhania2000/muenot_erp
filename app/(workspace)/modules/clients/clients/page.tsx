import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ClientsClient } from "@/components/clients/clients-client"

export default async function ClientsListPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "clients.view_clients")
  if (!canView) redirect("/modules/clients")
  const canManage = await userHasFeature(session.userId, session.role, "clients.manage_clients")

  return <ClientsClient canManage={canManage} />
}
