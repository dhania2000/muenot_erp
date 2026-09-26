import { Suspense } from "react"
import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { Party360View } from "@/components/party-360/party-360-view"

export default async function Customer360Page() {
  const session = await getSession()
  if (!session) redirect("/login")
  if (!(await userHasFeature(session.userId, session.role, "sales.view_companies"))) redirect("/modules/sales")
  return (
    <Suspense>
      <Party360View
        kind="customer"
        title="Customer 360"
        description="Profile, client accounts, leads, quotations, contracts, invoices, receipts, documents and activity for each customer."
      />
    </Suspense>
  )
}
