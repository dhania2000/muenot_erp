import { Landmark } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function BankReconciliationPage() {
  return (
    <SpecPage
      spec="SPEC 166"
      title="Bank Reconciliation"
      description="Match bank statement lines against ledger transactions to reconcile balances."
      icon={Landmark}
      capabilities={["Statement import", "Auto matching", "Manual matching", "Unreconciled items", "Adjustments"]}
      emptyTitle="Nothing to reconcile"
      emptyDescription="Bank reconciliation items will appear here."
    />
  )
}
