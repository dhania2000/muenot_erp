import { ReportBuilder } from "@/components/reports/report-builder"

// Custom Report Builder (UI). Authorized users compose a report over a
// whitelisted data source — columns, filters, grouping, sorting, calculations,
// date ranges — preview it, save it, and export it. All data access runs
// through the tenant-scoped, classification-redacted, capped query engine.

export default function ReportsPage() {
  return (
    <div className="flex flex-col gap-6 pl-4 sm:pl-6 lg:pl-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Report builder</h1>
        <p className="text-sm text-muted-foreground">
          Build, save, and export custom reports across your business data. Results are always scoped to your tenant
          and honor field-level security.
        </p>
      </header>

      <ReportBuilder />
    </div>
  )
}
