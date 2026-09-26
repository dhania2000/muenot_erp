import { Suspense } from "react"
import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { Party360View } from "@/components/party-360/party-360-view"

export default async function Vendor360Page() {
  const session = await getSession()
  if (!session) redirect("/login")
  if (!(await userHasFeature(session.userId, session.role, "finance.view_customers_vendors"))) redirect("/modules/finance")
  return (
    <Suspense>
      <Party360View
        kind="vendor"
        title="Vendor 360"
        description="Profile, purchase orders, bills, payments, contracts, documents and activity for each vendor."
      />
    </Suspense>
  )
}
