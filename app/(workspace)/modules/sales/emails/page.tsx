import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { SalesEmailHub } from "@/components/sales/sales-email-hub"

export default async function EmailsPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canSend = await userHasFeature(session.userId, session.role, "sales.send_emails")
  if (!canSend) redirect("/modules/sales")
  const canManage = await userHasFeature(session.userId, session.role, "sales.manage_email_templates")

  return <SalesEmailHub canSend={canSend} canManage={canManage} />
}
