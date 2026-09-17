import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runLibraryMaintenance } from "@/lib/library"

export const runtime = "nodejs"

/**
 * Daily Marketing Library maintenance (Phase 30/74).
 *
 * Auto-expires assets past their expiry date (notifying the uploader) and
 * raises a storage-capacity alert to admins when usage crosses the warning
 * threshold. Fully idempotent — a repeat run on the same day never
 * re-notifies. Authenticated for Vercel Cron with the shared CRON_SECRET
 * Bearer token (see vercel.json); a signed-in user may also trigger a manual
 * run. Mirrors /api/cron/employee-asset-reminders.
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
  const result = await runLibraryMaintenance()
  return NextResponse.json({ success: true, ...result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
