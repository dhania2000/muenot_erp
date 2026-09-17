import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runSubscriptionReminders } from "@/lib/company-subscriptions"

export const runtime = "nodejs"

/**
 * Daily Company Subscription reminders.
 *
 * Raises deduped in-app reminders to each subscription owner for renewals /
 * expiries that fall within the record's reminder lead window, and for trials
 * ending soon. Auto-flips lapsed Active/Trial subscriptions to Expired so the
 * register stays accurate without a page load. Idempotent via a per-record
 * per-day reminder key, so repeat runs never re-notify. Authenticated for
 * Vercel Cron with the shared CRON_SECRET Bearer token (see vercel.json); a
 * signed-in user may also trigger a manual run. Mirrors the employee-asset
 * reminder cron.
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
  const result = await runSubscriptionReminders()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
