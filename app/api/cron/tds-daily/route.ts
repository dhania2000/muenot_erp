import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runDailyTdsSweep } from "@/lib/finance-tds-automation"

export const runtime = "nodejs"

/**
 * Daily TDS sweep (Phase 64/65).
 *
 * Refreshes the durable reminder to-do list and pushes any overdue / due-soon
 * challan, return or certificate obligation — plus blocking data-quality
 * exceptions — into the in-app notification bell for every finance user who
 * holds the TDS Filing feature. Fully idempotent and dedup-guarded, so a repeat
 * run on the same day never re-notifies. Authenticated for Vercel Cron with the
 * shared CRON_SECRET Bearer token (see vercel.json); a signed-in user may also
 * trigger a manual sweep. Mirrors /api/cron/gst-daily.
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
  const result = await runDailyTdsSweep()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
