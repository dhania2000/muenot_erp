import { CheckCheck } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function ProcurementApprovalsPage() {
  return (
    <SpecPage
      spec="SPEC 142"
      title="Procurement Approval Matrix"
      description="Configure approval workflows by amount, entity, department and category."
      icon={CheckCheck}
      capabilities={["Amount thresholds", "Entity rules", "Department rules", "Category rules", "Escalation", "Delegation"]}
      emptyTitle="No approval rules"
      emptyDescription="Procurement approval matrix rules will appear here."
    />
  )
}
