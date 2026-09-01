import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { CompaniesClient } from "@/components/sales/companies-client"

export default async function CompaniesPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "sales.view_companies")
  if (!canView) redirect("/modules/sales")
  const canManage = await userHasFeature(session.userId, session.role, "sales.manage_companies")

  return <CompaniesClient canManage={canManage} />
}
