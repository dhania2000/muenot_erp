import { requirePlatformStaff } from "@/lib/platform-guard"
import { listShopkeeperPlans, listShopkeepers } from "@/lib/shopkeeper-provisioning"
import { ShopkeeperManager } from "@/components/platform/shopkeeper-manager"

export const dynamic = "force-dynamic"

export default async function ShopkeepersPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null
  const [shopkeepers, plans] = await Promise.all([listShopkeepers(), listShopkeeperPlans()])
  return <div className="flex flex-col gap-6"><header className="flex flex-col gap-1"><h1 className="text-2xl font-semibold tracking-tight">Shopkeepers</h1><p className="text-sm text-muted-foreground">Provision and manage Shopkeeper customers, owner access, subscriptions, and mobile readiness.</p></header><ShopkeeperManager shopkeepers={shopkeepers} plans={plans.map((plan) => ({ code: plan.code, name: plan.name }))} /></div>
}
