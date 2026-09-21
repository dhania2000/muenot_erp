import { GovernanceTabs } from "@/components/governance/governance-tabs"
import { RetentionPolicyEditor } from "@/components/governance/retention-policy-editor"

// SPEC 71 — General ERP Data Retention Engine (UI). Generalizes retention
// beyond storage files to any ERP record type, with legal-hold awareness.

export default function RetentionPage() {
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

      <RetentionPolicyEditor />
    </div>
  )
}
