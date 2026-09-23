import { CalendarRange } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function FiscalYearPage() {
  return (
    <SpecPage
      spec="SPEC 161"
      title="Fiscal Year Engine"
      description="Configure fiscal years per tenant and entity with periods and calendars."
      icon={CalendarRange}
      capabilities={["Fiscal years", "Periods", "Per-entity calendars", "Opening / closing", "Transitions"]}
      emptyTitle="No fiscal years"
      emptyDescription="Fiscal years and periods will appear here once configured."
    />
  )
}
