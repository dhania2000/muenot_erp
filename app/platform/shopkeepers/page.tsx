import { requirePlatformStaff } from "@/lib/platform-guard"
import { listShopkeeperPlans, listShopkeepers } from "@/lib/shopkeeper-provisioning"
import { ShopkeeperManager } from "@/components/platform/shopkeeper-manager"
import { ShopkeeperApplications } from "@/components/platform/shopkeeper-applications"
import { listApplications } from "@/lib/shopkeeper-applications"

export const dynamic = "force-dynamic"

export default async function ShopkeepersPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null
  const [shopkeepers, plans, applications] = await Promise.all([listShopkeepers(), listShopkeeperPlans(), listApplications()])
  const options = plans.map(plan => ({ code: plan.code, name: plan.name }))
  return <div className="flex flex-col gap-6"><header className="flex flex-col gap-1"><h1 className="text-2xl font-semibold tracking-tight">Shopkeepers</h1><p className="text-sm text-muted-foreground">Review applications and manage Shopkeeper customers, owner access, subscriptions, and mobile readiness.</p></header><ShopkeeperApplications applications={applications} plans={options} suspendedTenantIds={shopkeepers.filter(shop => shop.accountStatus === "suspended").map(shop => shop.tenantId)} /><ShopkeeperManager shopkeepers={shopkeepers} plans={options} /></div>
}
