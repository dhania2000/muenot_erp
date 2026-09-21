import { GovernanceTabs } from "@/components/governance/governance-tabs"
import { LegalHoldEditor } from "@/components/governance/legal-hold-editor"

// SPEC 72 — Generic Legal Hold (UI). Extends legal hold beyond files to
// Documents, HR, Finance, CRM, Projects, and other ERP record types.
// Retention/deletion jobs must always check active holds before acting.

export default function LegalHoldsPage() {
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

      <LegalHoldEditor />
    </div>
  )
}
