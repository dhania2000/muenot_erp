import { Lock } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function PeriodLockPage() {
  return (
    <SpecPage
      spec="SPEC 162"
      title="Accounting Period Lock"
      description="Let authorized finance users lock accounting periods to prevent back-dated entries."
      icon={Lock}
      capabilities={["Period locking", "Soft / hard locks", "Role permissions", "Unlock requests", "Audit trail"]}
      emptyTitle="No locked periods"
      emptyDescription="Locked accounting periods will appear here."
    />
  )
}
