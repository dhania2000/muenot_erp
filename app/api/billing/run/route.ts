import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { runRecurringBilling, BillingError } from "@/lib/billing/billing-engine"

export const runtime = "nodejs"

/**
 * SPEC 20 — Run a recurring billing cycle: generate an invoice for every
 * active subscription whose current period is not yet invoiced. Idempotent per
 * (subscription, period) so re-running is safe.
 */
export async function POST(request: Request) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const body = await request.json().catch(() => ({}))
    const taxRate = body.tax_rate == null ? 0 : Number(body.tax_rate)
    const result = await runRecurringBilling(session, { taxRate: Number.isFinite(taxRate) ? taxRate : 0 })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("[v0] POST /api/billing/run failed:", err)
    return NextResponse.json({ error: "Billing run failed" }, { status: 500 })
  }
}
