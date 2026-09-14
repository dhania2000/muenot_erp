import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runDailyGstSweep } from "@/lib/finance-gst-automation"

export const runtime = "nodejs"

/**
 * Daily GST sweep (Phase 37/38).
 *
 * Runs the exception / mismatch / unreconciled checks and the payment/filing
 * reminders for the period currently being worked on, then pushes any resulting
 * alerts into the in-app notification bell. Fully idempotent and dedup-guarded,
 * so a repeat run on the same day never re-notifies. Authenticated for Vercel
 * Cron with the shared CRON_SECRET Bearer token (see vercel.json); a signed-in
 * user may also trigger a manual sweep. Mirrors /api/cron/finance-emails.
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
  const result = await runDailyGstSweep()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
