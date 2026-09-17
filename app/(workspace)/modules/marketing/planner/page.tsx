import { MarketingPlannerClient } from "@/components/marketing/marketing-planner-client"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"

export const dynamic = "force-dynamic"

export default async function MarketingPlannerPage() {
  const session = await getSession()

  const check = (feature: string) =>
    session ? userHasFeature(session.userId, session.role, feature) : Promise.resolve(false)

  const [canManage, canPublish, canApprove, canAssign] = await Promise.all([
    check("marketing.planner.manage"),
    check("marketing.planner.publish"),
    check("marketing.planner.approve"),
    check("marketing.planner.assign"),
  ])

  return (
    <MarketingPlannerClient
      perms={{
        canManage,
        // Managers implicitly retain publish/assign rights on the server, mirror that here.
        canPublish: canPublish || canManage,
        canApprove,
        canAssign: canAssign || canManage,
      }}
    />
  )
}
