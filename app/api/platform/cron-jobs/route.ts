import { NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { listCronJobs, listCronRuns, updateCronJob } from "@/lib/cron-jobs"

export const dynamic = "force-dynamic"

export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const [jobs, runs] = await Promise.all([listCronJobs(), listCronRuns(100)])
    return NextResponse.json({ jobs, runs })
  } catch (error) {
    console.error("[cron-jobs] read failed", error)
    return NextResponse.json({ error: "Unable to load scheduled jobs" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const body = await req.json().catch(() => null)
  const key = typeof body?.key === "string" ? body.key : ""
  if (!key || !body?.config || typeof body.config !== "object") {
    return NextResponse.json({ error: "Job key and configuration are required" }, { status: 400 })
  }
  try {
    const job = await updateCronJob(key, body.config, guard.session.userId)
    return NextResponse.json({ ok: true, job })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update job" }, { status: 400 })
  }
}
