import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { forEachActiveTenant } from "@/lib/tenant-scope"
import { runDueTransitionsForTenant } from "@/lib/temporary-access-store"

export const runtime = "nodejs"

/**
 * SPEC 64 / 65 — Automatic revocation & scheduled activation of time-boxed
 * access grants.
 *
 * Fans out per active tenant (so one customer's grants can never touch
 * another's) and drives every due transition:
 *   - pending temporary grants whose scheduled start has arrived are activated
 *     (role elevation applied, access window set),
 *   - active grants past their expiry are revoked automatically (elevation
 *     reverted, access window cleared),
 *   - pending grants that lapsed before activation are closed out.
 * Every transition is audited and idempotent — re-running changes nothing once
 * grants are up to date.
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

  let activated = 0
  let expired = 0
  const fanout = await forEachActiveTenant(async (tenant) => {
    const result = await runDueTransitionsForTenant(tenant.tenantId)
    activated += result.activated
    expired += result.expired
  })

  return NextResponse.json({
    success: true,
    tenants_processed: fanout.processed,
    tenants_failed: fanout.failed,
    grants_activated: activated,
    grants_expired: expired,
  })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}
