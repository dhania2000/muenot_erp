import { CalendarClock } from "lucide-react"
import { ReportSchedulerClient } from "./report-scheduler-client"

export const dynamic = "force-dynamic"

export default function ReportSchedulerPage() {
  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <CalendarClock className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs font-medium text-muted-foreground">SPEC 98</div>
          <h1 className="text-2xl font-semibold tracking-tight">Report Scheduler</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Schedule saved reports to run automatically — daily, weekly, monthly, or on a custom
            cron — and deliver them as PDF, Excel, or CSV by email or a secure download link.
          </p>
        </div>
      </header>
      <ReportSchedulerClient />
    </div>
  )
}
