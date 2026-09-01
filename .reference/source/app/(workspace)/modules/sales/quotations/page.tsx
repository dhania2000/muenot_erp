import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { QuotationsClient } from "@/components/sales/quotations-client"

export default async function QuotationsPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "sales.view_quotations")
  if (!canView) redirect("/modules/sales")
  const canManage = await userHasFeature(session.userId, session.role, "sales.manage_quotations")

  return <QuotationsClient canManage={canManage} />
}
