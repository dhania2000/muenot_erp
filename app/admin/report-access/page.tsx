import { LockKeyhole } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function ReportAccessPage() {
  return (
    <SpecPage
      spec="SPEC 99"
      title="Report Access Control"
      description="Control who can view, run, export and share each report by role and data scope."
      icon={LockKeyhole}
      capabilities={["Role access", "Data-scope filters", "Export permissions", "Share permissions", "Access audit"]}
      emptyTitle="No access rules"
      emptyDescription="Report access rules will appear here once configured."
    />
  )
}
