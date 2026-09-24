import { redirect } from "next/navigation"
import { getSession } from "@/lib/auth"
import { getFeatureChecker } from "@/lib/permissions"
import { DealsClient } from "@/components/sales/deals-client"

export default async function DealsPage() {
  const session = await getSession()
  if (!session) redirect("/login")

  const has = await getFeatureChecker(session.userId, session.role)
  if (!has("sales.view_deals")) redirect("/modules/sales")

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Deals &amp; Pipeline</h2>
        <p className="text-sm text-muted-foreground">
          Drag deals across stages, track weighted forecast, and manage win / loss with approvals.
        </p>
      </div>
      <DealsClient canManage={has("sales.manage_deals")} canApprove={has("sales.approve_deals")} />
    </div>
  )
}
