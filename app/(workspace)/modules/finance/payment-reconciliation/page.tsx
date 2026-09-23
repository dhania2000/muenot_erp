import { ArrowLeftRight } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function PaymentReconciliationPage() {
  return (
    <SpecPage
      spec="SPEC 167"
      title="Payment Reconciliation"
      description="Connect payments with invoices and bills to reconcile receivables and payables."
      icon={ArrowLeftRight}
      capabilities={["Invoice matching", "Bill matching", "Partial payments", "Advances", "Write-offs", "Aging"]}
      emptyTitle="Nothing to reconcile"
      emptyDescription="Payment reconciliation items will appear here."
    />
  )
}
