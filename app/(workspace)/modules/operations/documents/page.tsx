import { FolderOpen } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function DocumentsPage() {
  return (
    <SpecPage
      spec="SPEC 86"
      title="Document Management System"
      description="Centralized enterprise document management across HR, Finance, CRM, Projects and Procurement."
      icon={FolderOpen}
      capabilities={[
        "Documents",
        "Folders",
        "Categories",
        "Tags",
        "Versions",
        "Owners",
        "Permissions",
        "Sharing",
        "Expiry",
        "Retention",
        "Approval",
        "Audit history",
      ]}
      emptyTitle="No documents yet"
      emptyDescription="Uploaded documents, folders and versions will appear here once storage is connected."
    />
  )
}
