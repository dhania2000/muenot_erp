import { ShoppingCart } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function ProcurementPage() {
  return (
    <SpecPage
      spec="SPEC 136"
      title="Procurement Management"
      description="Complete procurement lifecycle from requisition to purchase order, receipt and payment."
      icon={ShoppingCart}
      capabilities={["Requisitions", "RFQs", "Purchase orders", "Goods receipt", "Three-way match", "Approvals"]}
      emptyTitle="No procurement activity"
      emptyDescription="Procurement records across the lifecycle will appear here."
    />
  )
}
