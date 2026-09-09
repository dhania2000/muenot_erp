import type { Metadata } from "next"
import { CareersClient } from "@/components/recruit/careers-client"
import { PublicHeader, PublicFooter } from "@/components/recruit/public-header"

export const metadata: Metadata = {
  title: "Careers — Open Positions",
  description: "Explore open roles and apply to join our team.",
}

export default function CareersPage() {
  return (
    <div className="light flex min-h-screen flex-col bg-muted text-foreground [color-scheme:light]">
      <PublicHeader />
      <main className="flex-1">
        <CareersClient />
      </main>
      <PublicFooter />
    </div>
  )
}
