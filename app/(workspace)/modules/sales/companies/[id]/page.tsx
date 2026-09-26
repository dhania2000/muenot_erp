import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { RecordActivityPanel } from "@/components/collaboration/record-activity-panel"
import { CompanyDetailClient } from "@/components/sales/company-detail-client"

export default async function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "sales.view_companies")
  if (!canView) redirect("/modules/sales")
  const canManage = await userHasFeature(session.userId, session.role, "sales.manage_companies")

  const { id } = await params
  return (
    <>
      <CompanyDetailClient id={Number(id)} canManage={canManage} />
      <div className="px-4 pb-6 md:px-6">
        <RecordActivityPanel subjectType="company" subjectId={Number(id)} currentUserId={session.userId} isAdmin={session.role === "admin"} />
      </div>
    </>
  )
}
