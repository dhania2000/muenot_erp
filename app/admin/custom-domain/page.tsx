import { Globe } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function CustomDomainPage() {
  return (
    <SpecPage
      spec="SPEC 157"
      title="Custom Domain"
      description="Serve the workspace from your own domain with managed SSL and DNS verification."
      icon={Globe}
      capabilities={["Domain binding", "DNS verification", "SSL certificate", "Redirects", "Status monitoring"]}
      emptyTitle="No custom domain"
      emptyDescription="Configured domains and their verification status will appear here."
    />
  )
}
