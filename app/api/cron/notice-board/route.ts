import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runNoticeAutomation } from "@/lib/notice-board"

export const runtime = "nodejs"

/**
 * Scheduled Notice Board maintenance.
 *
 * Each sweep: promotes scheduled notices whose publish date has arrived
 * (materializing recipients and dispatching in-app/email notifications),
 * expires notices past their end date, and unpins expired notices unless they
 * are flagged to stay pinned. Runs unattended via Vercel Cron (see vercel.json)
 * authenticated with the shared `CRON_SECRET` Bearer token, and can also be
 * triggered on demand by a signed-in user. Mirrors /api/cron/calendar-sync.
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
  const origin = (() => { try { return new URL(request.url).origin } catch { return null } })()
  const result = await runNoticeAutomation(origin)
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
