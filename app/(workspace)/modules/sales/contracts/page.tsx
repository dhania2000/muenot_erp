import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ContractsClient } from "@/components/sales/contracts-client"

export default async function ContractsPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "sales.view_contracts")
  if (!canView) redirect("/modules/sales")
  const canManage = await userHasFeature(session.userId, session.role, "sales.manage_contracts")

  return <ContractsClient canManage={canManage} />
}
