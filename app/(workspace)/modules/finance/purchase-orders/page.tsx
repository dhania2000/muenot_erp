import { FileText } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function PurchaseOrdersPage() {
  return (
    <SpecPage
      spec="SPEC 139"
      title="Purchase Orders"
      description="Create and manage purchase orders to vendors with line items, terms and approvals."
      icon={FileText}
      capabilities={["Order creation", "Line items", "Terms", "Approvals", "Amendments", "Receipt linkage"]}
      emptyTitle="No purchase orders"
      emptyDescription="Purchase orders will appear here once created."
    />
  )
}
