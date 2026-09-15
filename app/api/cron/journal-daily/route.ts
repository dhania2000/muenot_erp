import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runDailyJournalSweep } from "@/lib/finance-journal-automation"

export const runtime = "nodejs"

/**
 * Daily Journal sweep (Phases 58/59).
 *
 * Runs the automatic journal checks (unposted, pending approval, source
 * mismatch, posting failure, duplicate, period-lock issues) for the working
 * period and pushes deduped alerts into the in-app notification bell. Fully
 * idempotent, so a repeat run on the same day never re-notifies. Authenticated
 * for Vercel Cron with the shared CRON_SECRET Bearer token (see vercel.json); a
 * signed-in user may also trigger a manual sweep. Mirrors /api/cron/gst-daily.
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
  const period = new URL(request.url).searchParams.get("period")
  const result = await runDailyJournalSweep(period)
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
