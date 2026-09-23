import { Palette } from "lucide-react"
import { SpecPage } from "@/components/spec/spec-page"

export default function BrandingPage() {
  return (
    <SpecPage
      spec="SPEC 155"
      title="Branding Engine"
      description="Configure logos, colors, typography and document themes applied across the workspace."
      icon={Palette}
      capabilities={["Logo", "Color palette", "Typography", "Email branding", "Document themes", "Favicon"]}
      emptyTitle="No branding configured"
      emptyDescription="Your brand settings will appear here once configured."
    />
  )
}
