import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { EsignClient } from "@/components/legal/esign-client"

export default async function LegalEsignPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "legal.view_esign")
  if (!canView) redirect("/dashboard")
  const canManage = await userHasFeature(session.userId, session.role, "legal.manage_esign")

  return <EsignClient canManage={canManage} />
}
