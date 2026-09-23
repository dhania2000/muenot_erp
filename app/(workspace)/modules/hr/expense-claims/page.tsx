import { ReceiptText } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function ExpenseClaimsPage() {
  return (
    <SpecPage
      spec="SPEC 127"
      title="Expense Claims & Reimbursements"
      description="Employees submit expense claims with receipts for approval and reimbursement."
      icon={ReceiptText}
      capabilities={["Claim submission", "Receipt upload", "Policy limits", "Approvals", "Reimbursement", "Reports"]}
      emptyTitle="No claims submitted"
      emptyDescription="Expense claims and their approval status will appear here."
    />
  )
}
