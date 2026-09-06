import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { InterviewsClient } from "@/components/recruit/interviews-client"

export default async function InterviewSchedulePage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "recruitment.schedule_interviews")
  if (!canView) redirect("/modules/recruitment")
  return <InterviewsClient canManage={canView} />
}
