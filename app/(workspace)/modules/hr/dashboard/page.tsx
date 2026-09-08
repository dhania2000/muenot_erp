import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { HrDashboardClient } from "@/components/hr/hr-dashboard-client"

export default async function HrDashboardPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const allowed = await userHasFeature(session.userId, session.role, "hr.view_dashboard")
  if (!allowed) redirect("/modules/hr")

  return <HrDashboardClient />
}
