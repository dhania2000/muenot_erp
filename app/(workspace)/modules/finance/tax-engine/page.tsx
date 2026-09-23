import { Percent } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function TaxEnginePage() {
  return (
    <SpecPage
      spec="SPEC 168"
      title="Tax Engine Foundation"
      description="Configurable tax engine defining tax types, rates and rules applied across transactions."
      icon={Percent}
      capabilities={["Tax types", "Rates", "Rules", "Jurisdictions", "Applicability", "Calculations"]}
      emptyTitle="No tax rules"
      emptyDescription="Tax types and rules will appear here once configured."
    />
  )
}
