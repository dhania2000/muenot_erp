import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { dispatchDueSalesEmails } from "@/lib/sales/sales-email-scheduler"

export const runtime = "nodejs"

/**
 * Scheduled sales-email dispatcher.
 *
 * Sends every sales email whose `scheduled_at` has arrived, plus queued
 * retries. Runs unattended via Vercel Cron (see vercel.json) authenticated
 * with the shared `CRON_SECRET` Bearer token, and can also be triggered on
 * demand by a signed-in user for a manual sweep. Mirrors /api/cron/contracts
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
  const result = await dispatchDueSalesEmails()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
