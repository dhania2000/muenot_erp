import { ClipboardPen } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function PurchaseRequisitionPage() {
  return (
    <SpecPage
      spec="SPEC 137"
      title="Purchase Requisition"
      description="Raise and route internal purchase requisitions for approval before procurement."
      icon={ClipboardPen}
      capabilities={["Requisition items", "Budget check", "Approval routing", "Conversion to RFQ / PO", "Status tracking"]}
      emptyTitle="No requisitions"
      emptyDescription="Purchase requisitions will appear here once raised."
    />
  )
}
