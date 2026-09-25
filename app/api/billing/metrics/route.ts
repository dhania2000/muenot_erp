import { NextResponse } from "next/server"
import { billingGuard, bindBillingTenant } from "@/lib/billing-guard"
import { getSaasMetrics } from "@/lib/billing/saas-metrics"
import { getPlatformTrialBalance } from "@/lib/billing/platform-ledger"
import { getDeferredBalance } from "@/lib/billing/revenue-recognition"

export const runtime = "nodejs"

/**
 * SaaS revenue metrics for the current platform tenant: MRR, ARR, churn and
 * revenue-by-plan (reconciled to invoices), plus the platform seller ledger's
 * trial balance and deferred-revenue position. Admin-only and tenant-scoped.
 */
export async function GET(request: Request) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  bindBillingTenant(session)
  try {
    const asOf = new URL(request.url).searchParams.get("as_of") ?? undefined
    const [metrics, trialBalance, deferred] = await Promise.all([
      getSaasMetrics(asOf),
      getPlatformTrialBalance(),
      getDeferredBalance(),
    ])
    return NextResponse.json({ ok: true, metrics, trialBalance, deferred })
  } catch (err) {
    console.error("[v0] GET /api/billing/metrics failed:", err)
    return NextResponse.json({ error: "Failed to load billing metrics" }, { status: 500 })
  }
}
