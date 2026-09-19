import { ListChecks } from "lucide-react"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { BackgroundJobsManager } from "@/components/platform/background-jobs-manager"

export const dynamic = "force-dynamic"

export default async function BackgroundJobsPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null
  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center gap-3">
        <ListChecks className="size-6 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Background jobs</h1>
          <p className="text-sm text-muted-foreground">Durable asynchronous work with retries, backoff and dead-letter protection.</p>
        </div>
      </header>
      <BackgroundJobsManager />
    </div>
  )
}
