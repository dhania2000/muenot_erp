import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { RecruitmentModuleClient } from "@/components/recruitment/recruitment-module-client"

// Phase 15: "Interview Schedule" and "Interview Tracker" are one system now.
// Both routes render the config-driven recruitment_interviews module so there
// is a single source of truth for every scheduled/tracked interview.
export default async function InterviewSchedulePage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "recruitment.schedule_interviews")
  if (!canView) redirect("/modules/recruitment")
  return <RecruitmentModuleClient moduleKey="interview-tracker" />
}
