import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { OnboardingClient } from "@/components/sales/onboarding-client"

export default async function OnboardingPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canManage = await userHasFeature(session.userId, session.role, "sales.manage_onboarding")
  if (!canManage) redirect("/modules/sales")

  return <OnboardingClient canManage={canManage} />
}
