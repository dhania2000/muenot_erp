import { Suspense } from "react"
import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { Party360View } from "@/components/party-360/party-360-view"

// No feature redirect here: users without hr.view_employees get a self-scoped
// view (their own record only), enforced by /api/party-360/employee.
export default async function Employee360Page() {
  const session = await getSession()
  if (!session) redirect("/login")
  return (
    <Suspense>
      <Party360View
        kind="employee"
        title="Employee 360"
        description="Profile, documents, assets, leave, support tickets, recruitment history and activity for each employee."
      />
    </Suspense>
  )
}
