import { billingGuard } from "@/lib/billing-guard"
import { StorageRetentionPanel } from "@/components/storage/storage-retention-panel"

// SPEC 36 — Storage → Retention.
export default async function Page() {
  await billingGuard()
  return (
    <div className="flex flex-col gap-8 p-6 md:p-8">
      <StorageRetentionPanel />
    </div>
  )
}
