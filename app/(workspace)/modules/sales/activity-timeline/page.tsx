import { Activity } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function ActivityTimelinePage() {
  return (
    <SpecPage
      spec="SPEC 109"
      title="Activity Timeline"
      description="Chronological feed of all interactions — calls, emails, meetings, notes and status changes."
      icon={Activity}
      capabilities={["Calls", "Emails", "Meetings", "Notes", "Status changes", "Filters", "Entity linking"]}
      emptyTitle="No activities"
      emptyDescription="Activities across records will appear here as a timeline."
    />
  )
}
