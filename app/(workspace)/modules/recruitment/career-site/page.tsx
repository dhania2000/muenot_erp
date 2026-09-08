import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { CareerSiteClient } from "@/components/recruit/career-site-client"

export default async function CareerSitePage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canManage = await userHasFeature(session.userId, session.role, "recruitment.view_jobs")
  if (!canManage) redirect("/modules/recruitment")
  return <CareerSiteClient />
}
