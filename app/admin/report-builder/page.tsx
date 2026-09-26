import { ReportBuilder } from "@/components/reports/report-builder"
import { LargeExportsPanel } from "@/components/reports/large-exports-panel"

export default function ReportBuilderPage() {
  return (
    <div className="flex flex-col gap-6 pl-4 sm:pl-6 lg:pl-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Custom report builder</h1>
        <p className="text-sm text-muted-foreground">
          Choose a data source, add filters and grouping, preview the result, then save or export it. Large exports run
          in the background and you are notified when the download is ready.
        </p>
      </header>

      <ReportBuilder />
      <LargeExportsPanel />
    </div>
  )
}
