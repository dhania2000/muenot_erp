import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getFeatureChecker } from "@/lib/permissions"
import { OrgHierarchyClient } from "@/components/organization/org-hierarchy-client"

export default async function OrganizationPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const can = await getFeatureChecker(session.userId, session.role)
  if (!can("organization.hierarchy")) redirect("/dashboard")
  const canManage = can("organization.hierarchy.manage") || session.role === "admin"
  return <OrgHierarchyClient canManage={canManage} />
}
