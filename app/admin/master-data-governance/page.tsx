import { ShieldCheck } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function MasterDataGovernancePage() {
  return (
    <SpecPage
      spec="SPEC 91"
      title="Master Data Governance"
      description="Ownership, approval and change control for master data with full audit history."
      icon={ShieldCheck}
      capabilities={["Data owners", "Change requests", "Approval workflow", "Versioning", "Audit trail", "Deactivation"]}
      emptyTitle="No governance rules"
      emptyDescription="Master data change requests and their approval status will appear here."
    />
  )
}
