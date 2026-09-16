import { Suspense } from "react"
import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ApplicationDetailClient } from "@/components/recruit/application-detail-client"

export default async function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) redirect("/login")
  const canManage = await userHasFeature(session.userId, session.role, "recruitment.applications")
  const canView =
    canManage || (await userHasFeature(session.userId, session.role, "recruitment.view_applications"))
  if (!canView) redirect("/modules/recruitment")
  const { id } = await params
  return (
    <Suspense>
      <ApplicationDetailClient applicationId={decodeURIComponent(id)} canManage={canManage} />
    </Suspense>
  )
}
