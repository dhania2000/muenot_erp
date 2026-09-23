import { Barcode } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function ReferenceNumbersPage() {
  return (
    <SpecPage
      spec="SPEC 93"
      title="Reference Number Management"
      description="Track and resolve generated reference numbers across all documents and modules."
      icon={Barcode}
      capabilities={["Lookup", "Cross-references", "Uniqueness checks", "Void / reissue", "Usage log"]}
      emptyTitle="No reference numbers"
      emptyDescription="Issued reference numbers will be listed here for lookup and tracing."
    />
  )
}
