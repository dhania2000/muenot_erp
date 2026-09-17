import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runMonitoringCleanup } from "@/lib/screen-monitoring"

export const runtime = "nodejs"

/**
 * Screen-monitoring maintenance sweep (Phase 8 / 19 / 20).
 *
 * Runs unattended via Vercel Cron (see vercel.json) with the shared
 * `CRON_SECRET` Bearer token — the same auth every other cron uses. Also
 * runnable on demand by a signed-in user. `runMonitoringCleanup` is idempotent:
 *   - closes stale Active/Pending sessions with no recent captures (a browser
 *     that was closed without Clock Out), and
 *   - purges screenshot bytes past the retention window (metadata retained for
 *     audit).
 */
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
  const result = await runMonitoringCleanup()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
