import { GovernanceTabs } from "@/components/governance/governance-tabs"
import { FieldSecurityEditor } from "@/components/governance/field-security-editor"

// Field-Level Security (UI). Server-enforced field access policies
// scoped by role / department / legal entity / permission group, applied to
// API responses, UI, exports, and reports.

export default function FieldSecurityPage() {
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

      <FieldSecurityEditor />
    </div>
  )
}
