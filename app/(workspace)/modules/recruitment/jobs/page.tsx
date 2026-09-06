import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { JobsClient } from "@/components/recruit/jobs-client"

export default async function JobsPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "recruitment.view_jobs")
  if (!canView) redirect("/modules/recruitment")
  return <JobsClient canManage={canView} />
}
