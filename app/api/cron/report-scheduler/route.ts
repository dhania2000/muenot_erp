import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runDueReportSchedules } from "@/lib/reports/scheduler-store"

/**
 * SPEC 98 Phase 1/2. Scheduled report delivery.
 *
 * Runs unattended every minute via the central scheduler (registered in
 * lib/cron-jobs.ts) authenticated with the shared CRON_SECRET Bearer token, and
 * is also runnable on demand by a signed-in user. Every active schedule whose
 * cron expression matches the current minute (in its timezone) is executed,
 * producing one durable run row and delivering by email or storage. Per-schedule
 * failures are isolated so one bad report cannot stall the sweep.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true
  return request.headers.get("authorization") === `Bearer ${secret}`
}

async function handle(request: Request) {
  if (!authorized(request)) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const result = await runDueReportSchedules()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
