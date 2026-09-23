import { Repeat } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function AutoJournalPage() {
  return (
    <SpecPage
      spec="SPEC 164"
      title="Automatic Journal Engine"
      description="Automatically generate accounting entries from business transactions across modules."
      icon={Repeat}
      capabilities={["Posting rules", "Triggers", "Templates", "Auto entries", "Review queue", "Audit"]}
      emptyTitle="No automatic entries"
      emptyDescription="Automatically generated journal entries will appear here."
    />
  )
}
