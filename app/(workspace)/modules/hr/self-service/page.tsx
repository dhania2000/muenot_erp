import { UserCog } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function SelfServicePage() {
  return (
    <SpecPage
      spec="SPEC 120"
      title="Employee Self-Service Portal"
      description="Let employees manage their own profile, requests, documents and payslips."
      icon={UserCog}
      capabilities={["Profile updates", "Leave requests", "Payslips", "Documents", "Reimbursements", "Declarations"]}
      emptyTitle="Self-service not available"
      emptyDescription="Employee self-service actions will appear here."
    />
  )
}
