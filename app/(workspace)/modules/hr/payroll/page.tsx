import { Banknote } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function PayrollPage() {
  return (
    <SpecPage
      spec="SPEC 126"
      title="Payroll Foundation"
      description="Salary structures, pay runs, deductions and payslip generation for the workforce."
      icon={Banknote}
      capabilities={["Salary structures", "Pay runs", "Earnings", "Deductions", "Statutory", "Payslips"]}
      emptyTitle="No payroll runs"
      emptyDescription="Pay runs and payslips will appear here once processed."
    />
  )
}
