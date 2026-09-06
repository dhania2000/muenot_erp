import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { OfferFormClient } from "@/components/recruit/offer-form-client"

export default async function CreateOfferPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "recruitment.manage_offers")
  if (!canView) redirect("/modules/recruitment")
  return <OfferFormClient />
}
