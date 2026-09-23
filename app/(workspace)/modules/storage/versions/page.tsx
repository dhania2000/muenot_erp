import { billingGuard } from "@/lib/billing-guard"
import { LargeUploadsPanel } from "@/components/storage/large-uploads-panel"
import { FileVersionsPanel } from "@/components/storage/file-versions-panel"

// Storage → Versions.
export default async function Page() {
  await billingGuard()
  return (
    <div className="flex flex-col gap-8 p-6 md:p-8">
      <LargeUploadsPanel />
      <FileVersionsPanel />
    </div>
  )
}
