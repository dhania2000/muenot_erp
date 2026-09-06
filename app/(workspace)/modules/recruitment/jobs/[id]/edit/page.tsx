import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { JobFormClient } from "@/components/recruit/job-form-client"

export default async function EditJobPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "recruitment.view_jobs")
  if (!canView) redirect("/modules/recruitment")
  const { id } = await params
  return <JobFormClient jobId={id} />
}
