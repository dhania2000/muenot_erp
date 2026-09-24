import { GovernanceTabs } from "@/components/governance/governance-tabs"
import { MasterDataGovernance } from "@/components/governance/master-data-governance"

// SPEC 91 — Master Data Governance. Adds a maker/checker lifecycle
// (Draft → Pending Approval → Active → Inactive → Archived) with owner,
// approval authority, effective dating and append-only change history to the
// critical SPEC 90 masters (currencies, payment terms, approval levels, cost
// centers). Backed by a real tenant-scoped, audited server model
// (lib/master-data/governance.ts) and its pure state machine (governance-model.ts).

export default function MasterDataGovernancePage() {
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

      <MasterDataGovernance />
    </div>
  )
}
