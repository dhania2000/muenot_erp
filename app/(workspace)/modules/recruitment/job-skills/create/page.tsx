import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { SkillFormClient } from "@/components/recruit/skill-form-client"

export default async function CreateSkillPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "recruitment.view_skills")
  if (!canView) redirect("/modules/recruitment")
  return <SkillFormClient />
}
