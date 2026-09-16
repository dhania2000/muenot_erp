import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runLoanScheduleReminders } from "@/lib/finance-loans-automation"

export const runtime = "nodejs"

/**
 * Daily Loans & Advances installment / interest reminders (Phase 11).
 *
 * Detects the schedule installments that are due (within a short look-ahead) or
 * overdue on still-open loans and raises deduped in-app reminders. Posts
 * nothing — repayment is a human-recorded bank event. Fully idempotent via the
 * per-installment dedup guard, so a repeat run on the same day never
 * re-notifies. Authenticated for Vercel Cron with the shared CRON_SECRET Bearer
 * token (see vercel.json); a signed-in user may also trigger a manual run and
 * may pass ?asOf=YYYY-MM-DD. Mirrors /api/cron/journal-daily.
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
  const asOf = new URL(request.url).searchParams.get("asOf")
  const result = await runLoanScheduleReminders(asOf)
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
