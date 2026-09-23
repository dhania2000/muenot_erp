import { CopyCheck } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function DuplicateDetectionPage() {
  return (
    <SpecPage
      spec="SPEC 103"
      title="Duplicate Detection"
      description="Detect and flag potential duplicate records across customers, vendors, contacts and more."
      icon={CopyCheck}
      capabilities={["Match rules", "Fuzzy matching", "Confidence scoring", "Merge suggestions", "Review queue"]}
      emptyTitle="No duplicates flagged"
      emptyDescription="Potential duplicate records will be surfaced here for review."
    />
  )
}
