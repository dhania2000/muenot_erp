import { CalendarClock } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function DocumentExpiryPage() {
  return (
    <SpecPage
      spec="SPEC 88"
      title="Document Expiry"
      description="Track expiry dates for contracts, certifications, licenses, insurance and compliance documents."
      icon={CalendarClock}
      capabilities={["Expiry notifications", "Escalation", "Renewal status", "Expired state", "Dashboard"]}
      emptyTitle="No expiring documents"
      emptyDescription="Documents with upcoming or past expiry dates will be listed here."
    />
  )
}
