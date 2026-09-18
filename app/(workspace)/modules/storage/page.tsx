import { billingGuard } from "@/lib/billing-guard"
import { StorageConnections } from "@/components/admin/storage-connections"
import { LargeUploadsPanel } from "@/components/storage/large-uploads-panel"

export default async function Page() {
  await billingGuard()
  return (
    <div className="flex flex-col gap-8 p-6 md:p-8">
      <StorageConnections />
      <LargeUploadsPanel />
    </div>
  )
}
