import type { Metadata } from "next"
import { JobBrowserClient } from "@/components/recruit/job-browser-client"
import { PublicHeader, PublicFooter } from "@/components/recruit/public-header"
import { getJobByHash } from "@/lib/recruit-db"
import { getCareersContent } from "@/lib/careers-settings-server"

export async function generateMetadata({ params }: { params: Promise<{ hash: string }> }): Promise<Metadata> {
  const { hash } = await params
  try {
    const job = await getJobByHash(hash)
    if (job && job.status === "open") {
      return { title: `${job.title} — Careers`, description: job.description?.slice(0, 150) || "Apply for this role." }
    }
  } catch {
    // ignore — fall back to default metadata
  }
  return { title: "Job Opening — Careers" }
}

export default async function JobOpeningPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params
  const content = await getCareersContent()
  return (
    <div
      className="light flex min-h-screen flex-col bg-muted text-foreground [color-scheme:light]"
      style={{ "--careers-accent": content.accentColor } as React.CSSProperties}
    >
      <PublicHeader />
      <main className="flex-1">
        <JobBrowserClient initialHash={hash} />
      </main>
      <PublicFooter />
    </div>
  )
}
