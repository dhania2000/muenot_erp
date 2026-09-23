import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { forEachActiveTenant } from "@/lib/tenant-scope"
import { sweepTenant } from "@/lib/access-review-store"

export const runtime = "nodejs"

/**
 * SPEC 66 — Scheduled access-review engine (Phases 2 & 4).
 *
 * Fans out per active tenant (isolating one customer's reviews from another's)
 * and drives every due transition:
 *   - recurring campaigns whose next occurrence has arrived spawn a fresh
 *     snapshot of the current access and advance their own schedule,
 *   - open campaigns past their due date raise their escalation tier and
 *     notify the reviewer / owner.
 * Every action is audited and idempotent — re-running changes nothing once
 * reviews are up to date.
 *
 * Authenticated for Vercel Cron via the shared CRON_SECRET Bearer token; a
 * signed-in user may also trigger a manual run.
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

  const systemActor = { userId: 0, name: "Access Review Scheduler", email: null }
  let spawned = 0
  let escalated = 0
  const fanout = await forEachActiveTenant(async (tenant) => {
    const result = await sweepTenant(tenant.tenantId, systemActor)
    spawned += result.spawned
    escalated += result.escalated
  })

  return NextResponse.json({
    success: true,
    tenants_processed: fanout.processed,
    tenants_failed: fanout.failed,
    campaigns_spawned: spawned,
    campaigns_escalated: escalated,
  })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
