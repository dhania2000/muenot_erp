import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { SalesDashboardClient } from "@/components/sales/sales-dashboard-client"

export default async function SalesDashboardPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const allowed = await userHasFeature(session.userId, session.role, "sales.view_dashboard")
  if (!allowed) redirect("/modules/sales")

  return <SalesDashboardClient />
}
