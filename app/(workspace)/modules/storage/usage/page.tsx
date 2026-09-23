import { billingGuard } from "@/lib/billing-guard"
import { StorageUsageDashboard } from "@/components/storage/storage-usage-dashboard"

// Storage → Usage & Quotas.
export default async function Page() {
  await billingGuard()
  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Usage &amp; quotas</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Track storage consumption against the plan quota (or a custom override), broken down by module, with
          warning and hard-limit controls.
        </p>
      </div>
      <StorageUsageDashboard />
    </div>
  )
}
