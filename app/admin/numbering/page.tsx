import { Hash } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function NumberingEnginePage() {
  return (
    <SpecPage
      spec="SPEC 92"
      title="Numbering Engine"
      description="Configurable auto-numbering sequences for invoices, orders, tickets and every document type."
      icon={Hash}
      capabilities={["Prefixes", "Suffixes", "Padding", "Reset cycles", "Fiscal-year reset", "Per-entity sequences"]}
      emptyTitle="No sequences configured"
      emptyDescription="Numbering sequences and their next values will appear here."
    />
  )
}
