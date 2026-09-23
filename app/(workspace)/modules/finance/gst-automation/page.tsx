import { FileSpreadsheet } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function GstAutomationPage() {
  return (
    <SpecPage
      spec="SPEC 169"
      title="GST Automation Foundation"
      description="Automated GST workflows for computation, input credit and return preparation."
      icon={FileSpreadsheet}
      capabilities={["GST computation", "Input credit", "Returns prep", "Reconciliation", "Reports"]}
      emptyTitle="No GST data"
      emptyDescription="GST automation workflows will appear here."
    />
  )
}
