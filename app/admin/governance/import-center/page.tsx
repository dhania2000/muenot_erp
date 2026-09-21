import { GovernanceTabs } from "@/components/governance/governance-tabs"
import { ImportCenterPanel } from "@/components/governance/import-center-panel"

// SPEC 74 — Central Import Center (UI). A generic
// upload → map → validate → preview → import → result flow that sits on top
// of existing module-specific import endpoints, rather than replacing them.

export default function ImportCenterPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Data governance</h1>
        <p className="text-sm text-muted-foreground">
          Central tenant audit log, classification, field security, retention, legal holds, and import/export
          centers.
        </p>
      </header>

      <GovernanceTabs />

      <ImportCenterPanel />
    </div>
  )
}
