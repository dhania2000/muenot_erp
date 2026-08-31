import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { EmailFinderClient } from "@/components/sales/email-finder-client"

export default async function GetEmailNamePage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canUse = await userHasFeature(session.userId, session.role, "sales.get_email_name")
  if (!canUse) redirect("/modules/sales")
  return <EmailFinderClient />
}
