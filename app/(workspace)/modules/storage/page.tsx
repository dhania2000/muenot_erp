import { billingGuard } from "@/lib/billing-guard"
import { FileBrowser } from "@/components/storage/file-browser"

// Storage → Files. The default landing page for the Storage module.
export default async function Page() {
  await billingGuard()
  return (
    <div className="flex flex-col gap-8 p-6 md:p-8">
      <FileBrowser />
    </div>
  )
}
