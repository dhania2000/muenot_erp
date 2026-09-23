import { FileQuestion } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function RfqPage() {
  return (
    <SpecPage
      spec="SPEC 138"
      title="RFQ Management"
      description="Issue requests for quotation to vendors and compare responses before awarding."
      icon={FileQuestion}
      capabilities={["RFQ creation", "Vendor selection", "Quote collection", "Comparison", "Award", "PO conversion"]}
      emptyTitle="No RFQs"
      emptyDescription="Requests for quotation will appear here once issued."
    />
  )
}
