import { BrandingEngine } from "@/components/admin/branding-engine"

export const metadata = {
  title: "Branding Engine",
  description: "Configure logos, favicon, colours and document themes for your workspace.",
}

export default function BrandingPage() {
  return <BrandingEngine />
}
