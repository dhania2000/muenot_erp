import type { Metadata } from "next"
import { CareersClient } from "@/components/recruit/careers-client"
import { PublicHeader, PublicFooter } from "@/components/recruit/public-header"
import { getCareersContent } from "@/lib/careers-settings-server"

export const metadata: Metadata = {
  title: "Careers — Open Positions",
  description: "Explore open roles and apply to join our team.",
}

export default async function CareersPage() {
  const content = await getCareersContent()
  return (
    <div
      className="light flex min-h-screen flex-col bg-muted text-foreground [color-scheme:light]"
      style={{ "--careers-accent": content.accentColor } as React.CSSProperties}
    >
      <PublicHeader />
      <main className="flex-1">
        <CareersClient content={content} />
      </main>
      <PublicFooter />
    </div>
  )
}
