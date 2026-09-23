import { MessageSquareText } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function CommunicationTemplatesPage() {
  return (
    <SpecPage
      spec="SPEC 154"
      title="Communication Template Engine"
      description="Centralized templates for email, SMS and in-app messages with variables and localization."
      icon={MessageSquareText}
      capabilities={["Email", "SMS", "In-app", "Merge variables", "Localization", "Versioning", "Preview"]}
      emptyTitle="No templates"
      emptyDescription="Communication templates will appear here once created."
    />
  )
}
