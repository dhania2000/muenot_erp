import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { forEachActiveTenant } from "@/lib/tenant-scope"
import { reconcileCurrentTenant } from "@/lib/billing/subscription-engine"

export const runtime = "nodejs"

/**
 * SPEC 16 — Daily SaaS subscription lifecycle sweep.
 *
 * Fans out per active tenant (so one customer's subscriptions can never touch
 * another's) and reconciles each tenant's subscriptions against the current
 * date: auto-renewing where enabled, and otherwise advancing lapsed records
 * through the past_due → grace → suspended → expired ladder. Every transition
 * is persisted and written to the append-only event log, so the engine stays
 * accurate without a page load. Idempotent — re-running produces no further
 * change once records are up to date.
 *
 * Authenticated for Vercel Cron via the shared CRON_SECRET Bearer token
 * (vercel.json); a signed-in user may also trigger a manual run.
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

  let scanned = 0
  let changed = 0
  const fanout = await forEachActiveTenant(async () => {
    const result = await reconcileCurrentTenant()
    scanned += result.scanned
    changed += result.changed
  })

  return NextResponse.json({
    success: true,
    tenants_processed: fanout.processed,
    tenants_failed: fanout.failed,
    subscriptions_scanned: scanned,
    subscriptions_changed: changed,
  })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
