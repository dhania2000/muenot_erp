import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { RecruitEmailTemplatesClient } from "@/components/recruit/recruit-email-templates-client"

export default async function RecruitEmailTemplatesPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "recruitment.view_applications")
  if (!canView) redirect("/modules/recruitment")
  return <RecruitEmailTemplatesClient />
}
