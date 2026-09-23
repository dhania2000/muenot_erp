import { ClipboardList } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function SalesOrdersPage() {
  return (
    <SpecPage
      spec="SPEC 117"
      title="Sales Orders"
      description="Convert quotations into confirmed sales orders and track fulfilment and invoicing."
      icon={ClipboardList}
      capabilities={["Order creation", "Quote conversion", "Line items", "Fulfilment status", "Invoicing link", "Approvals"]}
      emptyTitle="No sales orders"
      emptyDescription="Sales orders will appear here once created."
    />
  )
}
