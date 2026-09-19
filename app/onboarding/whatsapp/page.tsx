import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { WhatsAppOnboarding } from "@/components/onboarding/whatsapp-onboarding"

/**
 * SPEC — post-signup WhatsApp onboarding. Only a signed-in tenant admin lands
 * here (immediately after self-service signup). Employees and non-admins never
 * need this step, so they are sent to the app.
 */
export default async function WhatsAppOnboardingPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  if (session.role !== "admin") redirect("/")

  return <WhatsAppOnboarding adminName={session.name} />
}
