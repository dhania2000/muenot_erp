import { Sparkles } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function WhiteLabelPage() {
  return (
    <SpecPage
      spec="SPEC 156"
      title="White-Label Support"
      description="Fully rebrand the platform per tenant, hiding vendor identity across all surfaces."
      icon={Sparkles}
      capabilities={["Product name", "Login branding", "Email sender identity", "Support links", "Legal footer"]}
      emptyTitle="White-label not configured"
      emptyDescription="White-label settings will appear here once enabled."
    />
  )
}
