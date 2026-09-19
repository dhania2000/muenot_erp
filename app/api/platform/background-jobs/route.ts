import { NextResponse } from "next/server"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { getBackgroundJobStats, listBackgroundJobs } from "@/lib/background-jobs"
import { backgroundJobView } from "@/lib/background-job-view"

export const dynamic = "force-dynamic"

export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const [jobs, stats] = await Promise.all([listBackgroundJobs(), getBackgroundJobStats()])
    return NextResponse.json({ jobs: jobs.map(backgroundJobView), stats }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    console.error("[background-jobs] read failed", error)
    return NextResponse.json({ error: "Unable to load background jobs" }, { status: 500 })
  }
}
