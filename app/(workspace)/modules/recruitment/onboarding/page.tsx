import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { OnboardingClient } from "@/components/recruit/onboarding-client"

export default async function RecruitmentOnboardingPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canManage = await userHasFeature(session.userId, session.role, "recruitment.manage_offers")
  const canView =
    canManage || (await userHasFeature(session.userId, session.role, "recruitment.view_candidates"))
  if (!canView) redirect("/modules/recruitment")
  return <OnboardingClient canManage={canManage} />
}
