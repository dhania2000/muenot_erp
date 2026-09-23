import { Target } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function GoalsKpiPage() {
  return (
    <SpecPage
      spec="SPEC 135"
      title="Goals & KPI Engine"
      description="Set, cascade and track goals, OKRs and KPIs across teams and individuals."
      icon={Target}
      capabilities={["Objectives", "Key results", "Cascading", "Progress tracking", "Weightage", "Check-ins"]}
      emptyTitle="No goals set"
      emptyDescription="Goals, OKRs and KPIs will appear here once defined."
    />
  )
}
