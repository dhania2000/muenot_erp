import { Network } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function CostCentersPage() {
  return (
    <SpecPage
      spec="SPEC 144"
      title="Cost Center Management"
      description="Maintain hierarchical cost centers and allocate expenses for reporting."
      icon={Network}
      capabilities={["Hierarchy", "Allocations", "Expense mapping", "Reporting", "Budgets link"]}
      emptyTitle="No cost centers"
      emptyDescription="Cost centers will appear here once defined."
    />
  )
}
