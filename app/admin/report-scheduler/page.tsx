import { CalendarClock } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function ReportSchedulerPage() {
  return (
    <SpecPage
      spec="SPEC 98"
      title="Report Scheduler"
      description="Schedule reports to run and be delivered automatically to recipients."
      icon={CalendarClock}
      capabilities={["Schedules", "Recipients", "Formats (PDF / Excel / CSV)", "Delivery channels", "Run history"]}
      emptyTitle="No scheduled reports"
      emptyDescription="Scheduled report jobs and their run history will appear here."
    />
  )
}
