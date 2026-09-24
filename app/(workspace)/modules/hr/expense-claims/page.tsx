import { ExpenseClaimsClient } from "@/components/hr/expense-claims/expense-claims-client"

export const metadata = {
  title: "Expense Claims & Reimbursements",
  description: "Submit expense claims with receipts, mileage and corporate-card spend for approval and reimbursement.",
}

export default function ExpenseClaimsPage() {
  return <ExpenseClaimsClient />
}
