import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { SkillsClient } from "@/components/recruit/skills-client"

export default async function JobSkillsPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "recruitment.view_skills")
  if (!canView) redirect("/modules/recruitment")
  return <SkillsClient canManage={canView} />
}
