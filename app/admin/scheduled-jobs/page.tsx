import { Clock } from "lucide-react"
import { ScheduledJobsClient } from "./scheduled-jobs-client"

export const dynamic = "force-dynamic"

export default function ScheduledJobsPage() {
  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Clock className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs font-medium text-muted-foreground">SPEC 12</div>
          <h1 className="text-2xl font-semibold tracking-tight">Scheduled Jobs</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Schedule reviewed actions in your own timezone using presets or a validated cron
            expression. Due jobs run through the shared queue with per-tenant concurrency limits,
            with full run history, retries, dead letters and next-run visibility.
          </p>
        </div>
      </header>
      <ScheduledJobsClient />
    </div>
  )
}
