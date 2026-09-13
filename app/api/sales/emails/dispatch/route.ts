import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { requireFeature } from "@/lib/api-auth"
import { dispatchDueSalesEmails } from "@/lib/sales/sales-email-scheduler"

export const runtime = "nodejs"

/**
 * Dispatches due sales emails (scheduled sends + queued retries). Idempotent,
 * so it can run on any interval. Mirrors /api/hr/emails/dispatch.
 *
 * Auth: an unattended cron request carrying the shared `CRON_SECRET` as a
 * Bearer token, or a signed-in user with the send-emails permission for a
 * manual sweep.
 */
function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return request.headers.get("authorization") === `Bearer ${secret}`
}

async function run() {
  return { ok: true, ...(await dispatchDueSalesEmails()) }
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  return NextResponse.json(await run())
}

export async function POST(request: Request) {
  if (!isAuthorizedCron(request)) {
    const session = await requireFeature("sales.send_emails")
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  return NextResponse.json(await run())
}
