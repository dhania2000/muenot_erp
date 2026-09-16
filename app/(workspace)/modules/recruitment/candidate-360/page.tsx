import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { Candidate360Client } from "@/components/recruit/candidate-360-client"

export default async function Candidate360Page() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canManage = await userHasFeature(session.userId, session.role, "recruitment.candidates")
  const canView =
    canManage || (await userHasFeature(session.userId, session.role, "recruitment.view_candidates"))
  if (!canView) redirect("/modules/recruitment")
  return <Candidate360Client canManage={canManage} />
}
