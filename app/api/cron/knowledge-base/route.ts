import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runKbAutomation } from "@/lib/knowledge-base"

export const runtime = "nodejs"

/**
 * Scheduled Knowledge Base maintenance.
 *
 * Each sweep: auto-publishes scheduled articles whose publish time has arrived
 * (materializing recipients + dispatching in-app/email), auto-expires articles
 * past their expiry date, unpins expired/archived articles unless flagged to
 * stay pinned, retries failed emails, and sends acknowledgement + review
 * reminders. Runs unattended via Vercel Cron (see vercel.json) authenticated
 * with the shared `CRON_SECRET` Bearer token, and can also be triggered on
 * demand by a signed-in user. Mirrors /api/cron/notice-board.
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
  const result = await runKbAutomation(origin)
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}
export async function POST(request: Request) {
  return handle(request)
}
