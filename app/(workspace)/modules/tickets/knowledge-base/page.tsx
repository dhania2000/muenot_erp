import { BookOpen } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function KnowledgeBasePage() {
  return (
    <SpecPage
      spec="SPEC 152"
      title="Knowledge Base"
      description="Centralized knowledge base of articles for self-service support and internal reference."
      icon={BookOpen}
      capabilities={["Articles", "Categories", "Search", "Versioning", "Public / internal", "Feedback"]}
      emptyTitle="No articles"
      emptyDescription="Knowledge base articles will appear here once published."
    />
  )
}
