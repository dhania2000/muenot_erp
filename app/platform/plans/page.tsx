import { requirePlatformStaff } from "@/lib/platform-guard"
import { listPlans, listSubscriptions } from "@/lib/platform-console"
import { PlansManager } from "@/components/platform/plans-manager"

export const dynamic = "force-dynamic"

/**
 * SPEC 17 — Super Admin plan manager. The entitlement contract for every plan:
 * modules, quotas (users, employees, storage, API, automation, jobs, AI),
 * integrations, reports, support level and feature flags. Editing is
 * super-admin only; staff can view.
 */
export default async function PlansPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const [plans, subscriptions] = await Promise.all([listPlans(), listSubscriptions()])
  const canManage = guard.ctx.platformRole === "platform_super_admin"

  // How many tenants sit on each plan — context for the operator before edits.
  const tenantCounts: Record<string, number> = {}
  for (const s of subscriptions) {
    tenantCounts[s.plan_code] = (tenantCounts[s.plan_code] ?? 0) + 1
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Plans &amp; entitlements</h1>
        <p className="text-sm text-muted-foreground">
          Define what each plan grants: enabled modules, seat and resource quotas, report and support tiers,
          and feature flags. These entitlements are enforced across every tenant on the plan.
        </p>
      </header>

      <PlansManager plans={plans} tenantCounts={tenantCounts} canManage={canManage} />
    </div>
  )
}
