import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runPlannerCron } from "@/lib/marketing/planner-db"

export const runtime = "nodejs"

/**
 * Scheduled Marketing Planner sweep. Auto-publishes items whose scheduled time
 * has arrived and flags overdue work (see runPlannerCron in planner-db).
 *
 * Runs unattended via Vercel Cron (see vercel.json) authenticated with the
 * shared CRON_SECRET Bearer token, and can also be triggered on demand by a
 * signed-in user. Mirrors /api/cron/marketing-journeys.
 */
function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return request.headers.get("authorization") === `Bearer ${secret}`
}

async function handle(request: Request) {
  if (!isAuthorizedCron(request)) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const result = await runPlannerCron()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
