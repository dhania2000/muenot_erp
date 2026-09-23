import { Merge } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function RecordMergePage() {
  return (
    <SpecPage
      spec="SPEC 104"
      title="Record Merge Engine"
      description="Safely merge duplicate records while preserving relationships, history and references."
      icon={Merge}
      capabilities={["Field selection", "Relationship remapping", "Reference preservation", "Merge preview", "Undo log"]}
      emptyTitle="No merges yet"
      emptyDescription="Completed and pending record merges will appear here."
    />
  )
}
