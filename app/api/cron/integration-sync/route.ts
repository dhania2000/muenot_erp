import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { dispatchDueSyncs } from "@/lib/integration-sync/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Spec16 — scheduled integration sync dispatcher (#90-91).
 *
 * One tick: resumes retryable runs whose backoff has elapsed, then starts due
 * scheduled syncs. Each sync is driven inside its tenant context, bounded by
 * pages/attempts, and serialized per connection by a lease — so overlapping
 * ticks are safe and never double-run a connection. Runs unattended via Vercel
 * Cron authenticated with the shared CRON_SECRET Bearer token, and can also be
 * triggered on demand by a signed-in user. Mirrors /api/cron/calendar-sync.
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
  const summary = await dispatchDueSyncs()
  return NextResponse.json({ success: true, ...summary })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
