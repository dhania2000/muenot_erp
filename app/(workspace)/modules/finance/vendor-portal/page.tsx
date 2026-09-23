import { DoorOpen } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function VendorPortalPage() {
  return (
    <SpecPage
      spec="SPEC 119"
      title="Vendor Portal"
      description="Optional self-service portal where vendors view POs, submit invoices and track payments."
      icon={DoorOpen}
      capabilities={["Purchase orders", "Invoice submission", "Payment status", "Documents", "Messages"]}
      emptyTitle="Portal not configured"
      emptyDescription="Vendor portal access and content will appear here."
    />
  )
}
