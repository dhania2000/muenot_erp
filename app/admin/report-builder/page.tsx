import { Table2 } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function ReportBuilderPage() {
  return (
    <SpecPage
      spec="SPEC 97"
      title="Custom Report Builder"
      description="Design custom reports with data sources, filters, grouping and calculated columns."
      icon={Table2}
      capabilities={["Data sources", "Filters", "Grouping", "Aggregations", "Calculated fields", "Charts", "Saved reports"]}
      emptyTitle="No reports built"
      emptyDescription="Reports you create will be saved and listed here."
    />
  )
}
