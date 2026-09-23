import { Clock } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function TimezonePage() {
  return (
    <SpecPage
      spec="SPEC 158"
      title="Timezone Engine"
      description="Tenant and per-user timezones with consistent conversion across all timestamps."
      icon={Clock}
      capabilities={["Tenant default", "Per-user timezone", "DST handling", "Display conversion", "Working hours"]}
      emptyTitle="No timezone rules"
      emptyDescription="Timezone configuration will appear here once set."
    />
  )
}
