import { requirePlatformStaff } from "@/lib/platform-guard"
import { listPlans, listSubscriptions, listInvoices } from "@/lib/platform-console"
import { SubscriptionsManager } from "@/components/platform/subscriptions-manager"

export const dynamic = "force-dynamic"

export default async function SubscriptionsPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null

  const [plans, subscriptions, invoices] = await Promise.all([listPlans(), listSubscriptions(), listInvoices()])
  const canManagePlans = guard.ctx.platformRole === "platform_super_admin"

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Subscriptions &amp; billing</h1>
        <p className="text-sm text-muted-foreground">
          The plan catalog, every tenant&apos;s subscription, and the invoices derived from them. Change a
          tenant&apos;s plan or status and record payments against open invoices.
        </p>
      </header>

      <SubscriptionsManager
        plans={plans}
        subscriptions={subscriptions}
        invoices={invoices}
        canManagePlans={canManagePlans}
      />
    </div>
  )
}
