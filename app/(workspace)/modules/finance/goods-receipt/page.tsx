import { PackageCheck } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function GoodsReceiptPage() {
  return (
    <SpecPage
      spec="SPEC 140"
      title="Goods Receipt"
      description="Record receipt of goods and services against purchase orders with quantity checks."
      icon={PackageCheck}
      capabilities={["Receipt against PO", "Partial receipts", "Quantity checks", "Quality status", "Returns"]}
      emptyTitle="No goods receipts"
      emptyDescription="Goods receipt notes will appear here once recorded."
    />
  )
}
