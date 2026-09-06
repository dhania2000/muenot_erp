import { Suspense } from "react"
import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ApplicationsKanbanClient } from "@/components/recruit/applications-kanban-client"

export default async function JobApplicationsPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "recruitment.view_applications")
  if (!canView) redirect("/modules/recruitment")
  return (
    <Suspense fallback={null}>
      <ApplicationsKanbanClient canManage={canView} />
    </Suspense>
  )
}
