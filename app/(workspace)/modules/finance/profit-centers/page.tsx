import { LineChart } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function ProfitCentersPage() {
  return (
    <SpecPage
      spec="SPEC 145"
      title="Profit Center Management"
      description="Track profit centers and generate profitability reporting across the business."
      icon={LineChart}
      capabilities={["Profit centers", "Revenue mapping", "Cost mapping", "Profitability", "Reporting"]}
      emptyTitle="No profit centers"
      emptyDescription="Profit centers and profitability will appear here."
    />
  )
}
