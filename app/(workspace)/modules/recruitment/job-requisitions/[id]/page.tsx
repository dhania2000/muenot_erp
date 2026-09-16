import { Suspense } from "react"
import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { RequisitionDetailClient } from "@/components/recruit/requisition-detail-client"

export default async function RequisitionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) redirect("/login")
  const canManage = await userHasFeature(session.userId, session.role, "recruitment.requisitions")
  const canView =
    canManage || (await userHasFeature(session.userId, session.role, "recruitment.view_requisitions"))
  if (!canView) redirect("/modules/recruitment")
  const { id } = await params
  return (
    <Suspense>
      <RequisitionDetailClient requisitionId={decodeURIComponent(id)} canManage={canManage} />
    </Suspense>
  )
}
