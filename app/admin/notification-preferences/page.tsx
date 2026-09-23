import { BellRing } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function NotificationPreferencesPage() {
  return (
    <SpecPage
      spec="SPEC 153"
      title="Notification Preferences"
      description="Per-user and per-role control over which events trigger notifications and through which channels."
      icon={BellRing}
      capabilities={["In-app", "Email", "SMS", "Push", "Digest frequency", "Quiet hours", "Per-event opt-in"]}
      emptyTitle="No preferences set"
      emptyDescription="Notification preferences will appear here once configured."
    />
  )
}
