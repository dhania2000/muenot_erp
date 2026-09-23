import { Contact } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function Customer360Page() {
  return (
    <SpecPage
      spec="SPEC 105"
      title="Customer 360"
      description="Unified view of every customer — profile, deals, invoices, tickets, activities and documents."
      icon={Contact}
      capabilities={["Profile", "Deals", "Quotations", "Invoices", "Tickets", "Activities", "Documents", "Timeline"]}
      emptyTitle="No customer selected"
      emptyDescription="Select a customer to see their complete 360 profile here."
    />
  )
}
