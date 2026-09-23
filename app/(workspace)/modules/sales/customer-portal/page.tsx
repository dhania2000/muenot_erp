import { LayoutDashboard } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function CustomerPortalPage() {
  return (
    <SpecPage
      spec="SPEC 118"
      title="Customer Portal"
      description="Self-service portal where customers view quotes, orders, invoices, tickets and documents."
      icon={LayoutDashboard}
      capabilities={["Quotes", "Orders", "Invoices", "Payments", "Tickets", "Documents", "Announcements"]}
      emptyTitle="Portal not configured"
      emptyDescription="Customer portal access and content will appear here."
    />
  )
}
