import { PiggyBank } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function BudgetsPage() {
  return (
    <SpecPage
      spec="SPEC 143"
      title="Budget Management"
      description="Define budgets by period, entity and cost center and track actuals against them."
      icon={PiggyBank}
      capabilities={["Budget planning", "Allocations", "Actual vs budget", "Variance", "Alerts", "Revisions"]}
      emptyTitle="No budgets"
      emptyDescription="Budgets and their utilisation will appear here."
    />
  )
}
