import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { DashboardClient } from "@/components/recruit/dashboard-client"

export default async function RecruitDashboardPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canManage = await userHasFeature(session.userId, session.role, "recruitment.view_jobs")
  return <DashboardClient canManage={canManage} />
}
