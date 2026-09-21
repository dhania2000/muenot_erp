import { GovernanceTabs } from "@/components/governance/governance-tabs"
import { ClassificationEditor } from "@/components/governance/classification-editor"

// SPEC 69 — General Data Classification (UI). Generalizes classification
// beyond Finance to any module/entity/record/field, with the five standard
// sensitivity levels used elsewhere in the governance suite.

export default function ClassificationPage() {
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

      <ClassificationEditor />
    </div>
  )
}
