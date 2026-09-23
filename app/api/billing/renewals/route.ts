import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { getRenewalOverview } from "@/lib/billing/renewal-engine"

export const runtime = "nodejs"

/**
 * Renewal management overview: the enriched subscription views and
 * lifecycle summary, plus the recent renewal reminders and
 * failed-payment retry attempts recorded by the renewal cycle. Tenant-scoped
 * via billingGuard + the tenant-scope data layer.
 */
export async function GET() {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const overview = await getRenewalOverview()
    return NextResponse.json(overview)
  } catch (err) {
    console.error("[v0] GET /api/billing/renewals failed:", err)
    return NextResponse.json({ error: "Failed to load renewals" }, { status: 500 })
  }
}
