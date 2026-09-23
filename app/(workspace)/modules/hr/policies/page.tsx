import { BookMarked } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function PoliciesPage() {
  return (
    <SpecPage
      spec="SPEC 133"
      title="Policy Management"
      description="Publish company policies and track employee acknowledgements and versions."
      icon={BookMarked}
      capabilities={["Policy library", "Versioning", "Publishing", "Acknowledgements", "Reminders", "Audit"]}
      emptyTitle="No policies published"
      emptyDescription="Company policies and acknowledgement status will appear here."
    />
  )
}
