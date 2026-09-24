import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { Client360View } from "@/components/clients/client-360-view"

export default async function Client360Page({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>
}) {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "clients.view_clients")
  if (!canView) redirect("/modules/clients")
  const canManage = await userHasFeature(session.userId, session.role, "clients.manage_clients")

  const { client } = await searchParams
  const initialClientId = client && /^\d+$/.test(client) ? Number(client) : null

  return <Client360View canManage={canManage} initialClientId={initialClientId} />
}
