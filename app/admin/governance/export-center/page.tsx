import { GovernanceTabs } from "@/components/governance/governance-tabs"
import { ExportCenterPanel } from "@/components/governance/export-center-panel"

// Central Export Center (UI). A reusable export-job layer that
// wraps existing module-specific export buttons instead of replacing them —
// full-tenant and scheduled exports go through background jobs with
// permission-checked, expiring download links.

export default function ExportCenterPage() {
  return (
    <div className="flex flex-col gap-6 pl-4 sm:pl-6 lg:pl-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Data governance</h1>
        <p className="text-sm text-muted-foreground">
          Central tenant audit log, classification, field security, retention, legal holds, and import/export
          centers.
        </p>
      </header>

      <GovernanceTabs />

      <ExportCenterPanel />
    </div>
  )
}
