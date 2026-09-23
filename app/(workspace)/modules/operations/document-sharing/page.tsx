import { Share2 } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function DocumentSharingPage() {
  return (
    <SpecPage
      spec="SPEC 89"
      title="Document Sharing"
      description="Secure sharing with internal users, teams and external parties using signed, controllable links."
      icon={Share2}
      capabilities={[
        "Internal users",
        "Teams",
        "External users",
        "Expiring links",
        "Password protection",
        "Download restriction",
        "View-only access",
        "Access audit",
      ]}
      emptyTitle="No shared links"
      emptyDescription="Active and expired share links will appear here with their access audit trail."
    />
  )
}
