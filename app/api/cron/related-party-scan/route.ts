import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runRelatedPartyScan } from "@/lib/finance-related-parties-automation"

export const runtime = "nodejs"

/**
 * Daily Related Party transaction identification (Phase 11).
 *
 * Runs the existing scanner that matches every Finance transaction back to an
 * Active related party, then raises a single deduped in-app summary for the
 * transactions newly identified since the last run. Posts nothing — Related
 * Parties is a disclosure master. Each transaction is counted as new exactly
 * once via its permanent dedup key, and the summary is keyed to the run day, so
 * a repeat run never re-notifies. Authenticated for Vercel Cron with the shared
 * CRON_SECRET Bearer token (see vercel.json); a signed-in user may also trigger
 * a manual run. Mirrors /api/cron/journal-daily.
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
  const result = await runRelatedPartyScan()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
