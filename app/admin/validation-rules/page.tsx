import { CheckCheck } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function ValidationRulesPage() {
  return (
    <SpecPage
      spec="SPEC 102"
      title="Data Validation Engine"
      description="Define reusable validation rules enforced across forms, imports and API writes."
      icon={CheckCheck}
      capabilities={["Required", "Format / regex", "Ranges", "Cross-field", "Uniqueness", "Custom expressions"]}
      emptyTitle="No validation rules"
      emptyDescription="Validation rules defined for your modules will appear here."
    />
  )
}
