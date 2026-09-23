import { Building2 } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function Vendor360Page() {
  return (
    <SpecPage
      spec="SPEC 106"
      title="Vendor 360"
      description="Unified view of every vendor — profile, purchase orders, bills, payments and documents."
      icon={Building2}
      capabilities={["Profile", "Purchase orders", "Bills", "Payments", "Contracts", "Documents", "Timeline"]}
      emptyTitle="No vendor selected"
      emptyDescription="Select a vendor to see their complete 360 profile here."
    />
  )
}
