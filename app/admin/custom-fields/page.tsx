import { SlidersHorizontal } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function CustomFieldsPage() {
  return (
    <SpecPage
      spec="SPEC 94"
      title="Custom Fields"
      description="Extend any module's records with tenant-defined custom fields without code changes."
      icon={SlidersHorizontal}
      capabilities={["Text", "Number", "Date", "Dropdown", "Checkbox", "Lookup", "Validation", "Conditional visibility"]}
      emptyTitle="No custom fields"
      emptyDescription="Custom fields defined for your modules will appear here."
    />
  )
}
