import { Workflow } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function LifecyclePage() {
  return (
    <SpecPage
      spec="SPEC 121"
      title="Employee Lifecycle"
      description="Track employees through every stage from hire to exit with automated transitions."
      icon={Workflow}
      capabilities={["Onboarding", "Confirmation", "Transfers", "Promotions", "Role changes", "Exit"]}
      emptyTitle="No lifecycle events"
      emptyDescription="Employee lifecycle stages and transitions will appear here."
    />
  )
}
