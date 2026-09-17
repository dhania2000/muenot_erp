import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { ensureCallsSchema } from "@/lib/calls-ensure"
import { sweepStaleSessions } from "@/lib/calls-core"

export const runtime = "nodejs"

/**
 * Scheduled cleanup of stale internal call sessions (Phase 77). Ring-timed-out
 * calls become "missed" and long-idle connected calls become "failed", so no
 * user is ever left permanently "In Call" after a crash / tab close (Phase 76).
 * Authenticated with the shared CRON_SECRET Bearer token — the SAME auth every
 * other cron uses — and also runnable on demand by a signed-in user.
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
  await ensureCallsSchema()
  const result = await sweepStaleSessions()
  return NextResponse.json({ success: true, closed: result })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
