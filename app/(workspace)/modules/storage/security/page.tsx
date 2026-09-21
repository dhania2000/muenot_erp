import { billingGuard } from "@/lib/billing-guard"
import { StorageSecurityDashboard } from "@/components/storage/storage-security-dashboard"

// SPEC 34 — Storage → Security. Malware scan / quarantine dashboard.
export default async function Page() {
  await billingGuard()
  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Storage security</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Every uploaded file is scanned for malware before it can be downloaded. Review scan results, quarantine
          state and rescan or release files here.
        </p>
      </div>
      <StorageSecurityDashboard />
    </div>
  )
}
