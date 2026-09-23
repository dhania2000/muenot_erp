import { Database } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function MasterDataPage() {
  return (
    <SpecPage
      spec="SPEC 90"
      title="Centralized Master Data"
      description="Single source of truth for shared reference data used across every module."
      icon={Database}
      capabilities={[
        "Countries",
        "Currencies",
        "Departments",
        "Designations",
        "Locations",
        "Cost centers",
        "Tax codes",
        "Units of measure",
        "Payment terms",
      ]}
      emptyTitle="No master data defined"
      emptyDescription="Reference data sets will appear here once configured."
    />
  )
}
