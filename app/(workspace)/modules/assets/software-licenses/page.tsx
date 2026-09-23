import { KeyRound } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function SoftwareLicensesPage() {
  return (
    <SpecPage
      spec="SPEC 130"
      title="Software License Management"
      description="Track software licenses, seats, renewals and compliance across the organization."
      icon={KeyRound}
      capabilities={["License catalog", "Seat allocation", "Renewals", "Compliance", "Cost tracking", "Alerts"]}
      emptyTitle="No licenses"
      emptyDescription="Software licenses will appear here once added."
    />
  )
}
