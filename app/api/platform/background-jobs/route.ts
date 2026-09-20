import { NextResponse } from "next/server"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { getBackgroundJobStats, listBackgroundJobs } from "@/lib/background-jobs"
import { backgroundJobView } from "@/lib/background-job-view"
import { listJobFailureNotices } from "@/lib/job-manual-retry"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const deadLetterOnly = new URL(request.url).searchParams.get("status") === "dead_letter"
    const [jobs, stats, notices] = await Promise.all([listBackgroundJobs(deadLetterOnly ? { status: "dead_letter" } : {}), getBackgroundJobStats(), listJobFailureNotices()])
    return NextResponse.json({ jobs: jobs.map(backgroundJobView), stats, notices, canRetry: guard.ctx.platformRole === "platform_super_admin" }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    console.error("[background-jobs] read failed", error)
    return NextResponse.json({ error: "Unable to load background jobs" }, { status: 500 })
  }
}
