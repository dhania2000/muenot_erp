import { NextResponse } from "next/server"
import { billingGuard, bindBillingTenant } from "@/lib/billing-guard"
import { getUsageOverview } from "@/lib/billing/usage-metering"

export const runtime = "nodejs"

/**
 * GET the current tenant's usage overview: every meter's usage for
 * the active period against its configured limit, plus a daily trend series.
 * Admin-only (billingGuard); tenant is derived from session context.
 */
export async function GET(request: Request) {
  const session = await billingGuard()
  bindBillingTenant(session)
  const { searchParams } = new URL(request.url)
  const trendDays = Number(searchParams.get("trendDays") ?? 30)
  try {
    const overview = await getUsageOverview({ trendDays: Number.isFinite(trendDays) ? trendDays : 30 })
    return NextResponse.json(overview)
  } catch (err) {
    console.error("[v0] usage overview failed:", err)
    return NextResponse.json({ error: "Failed to load usage" }, { status: 500 })
  }
}
