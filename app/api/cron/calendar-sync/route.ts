import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { reconcileAllUsers } from "@/lib/calendar/sync-engine"

export const runtime = "nodejs"

/**
 * Scheduled central calendar reconciliation (spec Phases 30-33, 71-73).
 *
 * Sweeps every user with a connected Google account and retries any source
 * event whose Google sync is `Failed` or `Pending`, reusing stored event ids so
 * retries never duplicate. Runs unattended via Vercel Cron (see vercel.json)
 * authenticated with the shared `CRON_SECRET` Bearer token, and can also be
 * triggered on demand by a signed-in user. Mirrors /api/cron/recruit-reminders.
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
  const result = await reconcileAllUsers()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
