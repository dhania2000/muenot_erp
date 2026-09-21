import { billingGuard } from "@/lib/billing-guard"
import { StorageConnections } from "@/components/storage/storage-connections"
import { StorageHealthPanel } from "@/components/storage/storage-health-panel"
import { StorageMigrationPanel } from "@/components/storage/storage-migration-panel"

// SPEC 26–31 — Storage → Health. Connections, diagnostics and migrations.
export default async function Page() {
  await billingGuard()
  return (
    <div className="flex flex-col gap-8 p-6 md:p-8">
      <StorageConnections />
      <StorageHealthPanel />
      <StorageMigrationPanel />
    </div>
  )
}
