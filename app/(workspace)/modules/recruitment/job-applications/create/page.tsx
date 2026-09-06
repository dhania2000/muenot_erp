import { Suspense } from "react"
import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ApplicationFormClient } from "@/components/recruit/application-form-client"

export default async function CreateApplicationPage() {
  const session = await getSession()
  if (!session) redirect("/login")
  const canView = await userHasFeature(session.userId, session.role, "recruitment.view_applications")
  if (!canView) redirect("/modules/recruitment")
  return (
    <Suspense fallback={null}>
      <ApplicationFormClient />
    </Suspense>
  )
}
