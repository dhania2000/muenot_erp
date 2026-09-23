import { LayoutTemplate } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function CustomFormsPage() {
  return (
    <SpecPage
      spec="SPEC 95"
      title="Custom Forms"
      description="Build and publish custom data-entry forms with layout, sections and validation rules."
      icon={LayoutTemplate}
      capabilities={["Form builder", "Sections", "Field mapping", "Validation", "Publishing", "Versioning"]}
      emptyTitle="No forms created"
      emptyDescription="Custom forms you build will appear here."
    />
  )
}
