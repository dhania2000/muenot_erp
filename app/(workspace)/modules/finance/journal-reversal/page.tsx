import { Undo2 } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function JournalReversalPage() {
  return (
    <SpecPage
      spec="SPEC 165"
      title="Journal Reversal & Adjustment"
      description="Reverse or adjust posted journal entries with full traceability."
      icon={Undo2}
      capabilities={["Reversals", "Adjustments", "Linked entries", "Reason codes", "Approvals", "Audit trail"]}
      emptyTitle="No reversals"
      emptyDescription="Journal reversals and adjustments will appear here."
    />
  )
}
