import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { CandidatesClient } from "@/components/recruit/candidates-client"

export default async function CandidateDatabasePage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "recruitment.view_candidates")
  if (!canView) redirect("/modules/recruitment")
  return <CandidatesClient />
}
