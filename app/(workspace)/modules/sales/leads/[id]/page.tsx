import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { LeadDetailClient } from "@/components/sales/lead-detail-client"
import { RecordActivityPanel } from "@/components/collaboration/record-activity-panel"

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "sales.view_leads")
  if (!canView) redirect("/modules/sales")
  const canManage = await userHasFeature(session.userId, session.role, "sales.manage_leads")

  const { id } = await params
  return (
    <>
      <LeadDetailClient id={Number(id)} canManage={canManage} />
      <div className="px-4 pb-6 md:px-6">
        <RecordActivityPanel subjectType="lead" subjectId={Number(id)} currentUserId={session.userId} isAdmin={session.role === "admin"} />
      </div>
    </>
  )
}
