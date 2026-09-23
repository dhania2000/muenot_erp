import { Boxes } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function CoreIntegrationPage() {
  return (
    <SpecPage
      spec="SPEC 163"
      title="Finance Core Integration"
      description="Connect Finance with Sales, Procurement, HR and other modules for unified accounting."
      icon={Boxes}
      capabilities={["Sales link", "Procurement link", "HR / payroll link", "Assets link", "Mapping rules"]}
      emptyTitle="No integrations mapped"
      emptyDescription="Module integration mappings will appear here."
    />
  )
}
