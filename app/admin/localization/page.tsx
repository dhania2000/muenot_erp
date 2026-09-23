import { Languages } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function LocalizationPage() {
  return (
    <SpecPage
      spec="SPEC 160"
      title="Multi-Language / Localization"
      description="Manage supported languages, translations and locale-specific formatting."
      icon={Languages}
      capabilities={["Languages", "Translation strings", "Number / date formats", "RTL support", "Per-user locale"]}
      emptyTitle="No languages configured"
      emptyDescription="Supported languages and translations will appear here."
    />
  )
}
