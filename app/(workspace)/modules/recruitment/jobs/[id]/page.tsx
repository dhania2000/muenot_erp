import { Suspense } from "react"
import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { JobDetailClient } from "@/components/recruit/job-detail-client"

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) redirect("/login")
  const canManage = await userHasFeature(session.userId, session.role, "recruitment.jobs")
  const canView = canManage || (await userHasFeature(session.userId, session.role, "recruitment.view_jobs"))
  if (!canView) redirect("/modules/recruitment")
  const { id } = await params
  return (
    <Suspense>
      <JobDetailClient jobId={decodeURIComponent(id)} canManage={canManage} />
    </Suspense>
  )
}
