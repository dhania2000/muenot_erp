import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ForecastClient } from "@/components/sales/forecast-client"

export default async function ForecastPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "sales.view_dashboard")
  if (!canView) redirect("/modules/sales")

  return <ForecastClient canManage={canView} />
}
