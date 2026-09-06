import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ReportClient } from "@/components/recruit/report-client"

export default async function RecruitJobReportPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "recruitment.view_reports")
  if (!canView) redirect("/modules/recruitment")
  return <ReportClient />
}
