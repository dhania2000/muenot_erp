import { FileCheck2 } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function DocumentApprovalPage() {
  return (
    <SpecPage
      spec="SPEC 87"
      title="Document Approval"
      description="Configurable approval workflows for SOPs, policies, contracts, invoice attachments and HR documents."
      icon={FileCheck2}
      capabilities={["Draft", "Submitted", "Review", "Approved", "Rejected", "Published", "Archived"]}
      emptyTitle="No approvals pending"
      emptyDescription="Documents submitted for approval will appear here with their current workflow stage."
    />
  )
}
