import { billingGuard } from "@/lib/billing-guard"
import { StorageConnections } from "@/components/admin/storage-connections"
import { LargeUploadsPanel } from "@/components/storage/large-uploads-panel"
import { StorageHealthPanel } from "@/components/storage/storage-health-panel"
import { StorageMigrationPanel } from "@/components/storage/storage-migration-panel"
import { FileVersionsPanel } from "@/components/storage/file-versions-panel"

export default async function Page() {
  await billingGuard()
  return (
    <div className="flex flex-col gap-8 p-6 md:p-8">
      <StorageConnections />
      <StorageHealthPanel />
      <StorageMigrationPanel />
      <LargeUploadsPanel />
    </div>
  )
}
