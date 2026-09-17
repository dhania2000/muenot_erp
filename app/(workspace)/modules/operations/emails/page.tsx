import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { EmailHub } from "@/components/email-hub/email-hub"

export default async function OperationsEmailsPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "operations.emails")
  if (!canView) redirect("/modules/operations")
  return <EmailHub moduleKey="operations" />
}
