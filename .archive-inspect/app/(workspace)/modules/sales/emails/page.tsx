import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { EmailsClient } from "@/components/sales/emails-client"

export default async function EmailsPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canSend = await userHasFeature(session.userId, session.role, "sales.send_emails")
  if (!canSend) redirect("/modules/sales")

  return <EmailsClient canSend={canSend} />
}
