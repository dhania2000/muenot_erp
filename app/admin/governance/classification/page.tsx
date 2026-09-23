import { GovernanceTabs } from "@/components/governance/governance-tabs"
import { ClassificationEditor } from "@/components/governance/classification-editor"

// Data Classification. Generalizes classification beyond Finance to
// any module/entity/field, with the five standard sensitivity levels. Backed
// by a real, tenant-scoped, audited server model (lib/data-classification.ts)
// whose clearance matrix + per-mapping toggles influence access, export and
// retention wherever configured.

export default function ClassificationPage() {
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

      <ClassificationEditor />
    </div>
  )
}
