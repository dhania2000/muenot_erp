import { Clock3 } from "lucide-react"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { CronJobsManager } from "@/components/platform/cron-jobs-manager"

export const dynamic = "force-dynamic"

export default async function PlatformCronJobsPage() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return null
  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center gap-3">
        <Clock3 className="size-6 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Scheduled jobs</h1>
          <p className="text-sm text-muted-foreground">Configure safe schedules, retries, timeouts and failure notifications.</p>
        </div>
      </header>
      <CronJobsManager />
    </div>
  )
}
