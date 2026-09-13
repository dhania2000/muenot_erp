import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { dispatchDueFinanceEmails } from "@/lib/finance-email"

export const runtime = "nodejs"

/**
 * Scheduled finance-email dispatcher.
 *
 * Sends every finance email whose `scheduled_at` has arrived, plus queued
 * retries. Runs unattended via Vercel Cron (see vercel.json) authenticated
 * with the shared `CRON_SECRET` Bearer token, and can also be triggered on
 * demand by a signed-in user for a manual sweep. Mirrors /api/cron/sales-emails
 * and the HR email dispatcher.
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
  const result = await dispatchDueFinanceEmails()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
