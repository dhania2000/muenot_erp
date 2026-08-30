import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { EmailTemplatesClient } from "@/components/sales/email-templates-client"

export default async function EmailTemplatesPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "sales.view_email_templates")
  if (!canView) redirect("/modules/sales")
  const canManage = await userHasFeature(session.userId, session.role, "sales.manage_email_templates")

  return <EmailTemplatesClient canManage={canManage} />
}
