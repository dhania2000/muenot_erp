import { GovernanceTabs } from "@/components/governance/governance-tabs"
import { PrivacyPanel } from "@/components/governance/privacy-panel"

// Spec24 — Privacy, consent & safe deletion (UI).
// Three workflows on one page: tenant deletion (cooling period, mandatory
// export, legal-hold block, retention proof, final approval), data-subject
// requests (export / anonymize / erase), and the consent & notice ledger.

export default function PrivacyPage() {
  return (
    <div className="flex flex-col gap-6 pl-4 sm:pl-6 lg:pl-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Data governance</h1>
        <p className="text-sm text-muted-foreground">
          Privacy, consent, and safe deletion — tenant offboarding, data-subject rights, and the consent ledger.
        </p>
      </header>

      <GovernanceTabs />

      <PrivacyPanel />
    </div>
  )
}
