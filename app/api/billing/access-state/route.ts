import { NextResponse } from "next/server"
import { resolveTenantWriteAccess } from "@/lib/billing/write-access"
import { BILLING_GATE_HEADER, billingWriteLockToken, safeEqual } from "@/lib/maintenance/gate-token"

/**
 * Plan entitlements for the middleware plan gate. null = the tenant has no
 * platform subscription (legacy/unsubscribed → ungated), and a lookup failure
 * also yields null so a plan-store outage never strips every tenant's modules.
 */
async function resolveTenantPlan(tenantId: number) {
  try {
    const { getSubscriptionForTenant } = await import("@/lib/platform-console")
    if (!(await getSubscriptionForTenant(tenantId))) return null
    const { getTenantEntitlements } = await import("@/lib/platform/entitlement-guard")
    return await getTenantEntitlements(tenantId)
  } catch {
    return null
  }
}

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Spec46 — internal feed for the middleware write-lock gate. Returns whether a
 * tenant may mutate data given its subscription lifecycle. Guarded by a secret
 * derived from SESSION_SECRET; anyone else gets 404 (non-disclosure).
 */
export async function GET(req: Request) {
  const expected = await billingWriteLockToken(process.env.SESSION_SECRET)
  const presented = req.headers.get(BILLING_GATE_HEADER) ?? ""
  if (!expected || !safeEqual(presented, expected)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  const tenantId = Number(new URL(req.url).searchParams.get("tenantId"))
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    return NextResponse.json({ error: "tenantId must be a positive integer" }, { status: 400 })
  }
  try {
    const state = await resolveTenantWriteAccess(tenantId)
    const plan = await resolveTenantPlan(tenantId)
    return NextResponse.json({ ...state, plan }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return NextResponse.json({ error: "Unavailable" }, { status: 503 })
  }
}
