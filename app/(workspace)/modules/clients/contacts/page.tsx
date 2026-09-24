import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ContactsClient } from "@/components/contacts/contacts-client"

export default async function ContactsPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "clients.view_contacts")
  if (!canView) redirect("/modules/clients")
  const canManage = await userHasFeature(session.userId, session.role, "clients.manage_contacts")

  return <ContactsClient canManage={canManage} />
}
