import type { Metadata } from "next"
import { PublicApplyClient } from "@/components/recruit/public-apply-client"
import { PublicHeader, PublicFooter } from "@/components/recruit/public-header"
import { getJobByHash } from "@/lib/recruit-db"

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
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <PublicHeader />
      <main className="flex-1">
        <PublicApplyClient hash={hash} />
      </main>
      <PublicFooter />
    </div>
  )
}
