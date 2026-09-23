import { Users } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function ContactsPage() {
  return (
    <SpecPage
      spec="SPEC 108"
      title="Contact Management"
      description="Central directory of contacts linked to companies, leads, customers and vendors."
      icon={Users}
      capabilities={["Contacts", "Company links", "Roles", "Communication log", "Tags", "Deduplication"]}
      emptyTitle="No contacts"
      emptyDescription="Contacts will appear here once added."
    />
  )
}
