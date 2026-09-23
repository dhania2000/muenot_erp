import { TrendingUp } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function PerformancePage() {
  return (
    <SpecPage
      spec="SPEC 134"
      title="Performance Management"
      description="Run appraisal cycles with self, manager and peer reviews tied to goals."
      icon={TrendingUp}
      capabilities={["Review cycles", "Self review", "Manager review", "360 feedback", "Ratings", "Calibration"]}
      emptyTitle="No review cycles"
      emptyDescription="Performance review cycles will appear here once started."
    />
  )
}
