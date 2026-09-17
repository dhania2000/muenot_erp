import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runAssetReminders } from "@/lib/employee-assets"

export const runtime = "nodejs"

/**
 * Daily Employee Assets reminders (Phase 36–39).
 *
 * Raises deduped in-app reminders for assignments whose expected return date is
 * due soon or overdue, and recovery alerts for assets still held by offboarded /
 * inactive employees. Also reconciles assignments whose finance asset went
 * terminal. Fully idempotent via the per-assignment dedup key, so a repeat run
 * on the same day never re-notifies. Authenticated for Vercel Cron with the
 * shared CRON_SECRET Bearer token (see vercel.json); a signed-in user may also
 * trigger a manual run and may pass ?asOf=YYYY-MM-DD. Mirrors
 * /api/cron/loan-reminders.
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
  const result = await runAssetReminders(asOf)
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
