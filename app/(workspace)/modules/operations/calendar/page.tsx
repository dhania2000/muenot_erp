import { CalendarDays } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function CalendarPage() {
  return (
    <SpecPage
      spec="SPEC 111"
      title="Calendar & Scheduling"
      description="Unified calendar of tasks, meetings, deadlines and events across the workspace."
      icon={CalendarDays}
      capabilities={["Day / week / month views", "Tasks", "Meetings", "Deadlines", "Reminders", "Shared calendars"]}
      emptyTitle="No events"
      emptyDescription="Scheduled tasks, meetings and events will appear on the calendar."
    />
  )
}
