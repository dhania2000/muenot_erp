import { Blocks } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function CustomModulesPage() {
  return (
    <SpecPage
      spec="SPEC 96"
      title="Custom Module Framework"
      description="Create entirely new modules with their own entities, fields, forms and permissions."
      icon={Blocks}
      capabilities={["Entities", "Relationships", "Forms", "List views", "Permissions", "Navigation placement"]}
      emptyTitle="No custom modules"
      emptyDescription="Custom modules created for your workspace will appear here."
    />
  )
}
