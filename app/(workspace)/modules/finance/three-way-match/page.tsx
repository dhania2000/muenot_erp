import { GitCompareArrows } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function ThreeWayMatchPage() {
  return (
    <SpecPage
      spec="SPEC 141"
      title="Three-Way Match"
      description="Automatically match purchase orders, goods receipts and vendor bills before payment."
      icon={GitCompareArrows}
      capabilities={["PO vs GRN vs bill", "Variance detection", "Tolerance rules", "Exceptions", "Approval hold"]}
      emptyTitle="Nothing to match"
      emptyDescription="Three-way match results will appear here."
    />
  )
}
