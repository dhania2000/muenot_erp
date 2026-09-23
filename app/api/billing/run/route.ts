import { NextResponse } from "next/server"
import { billingGuard, bindBillingTenant } from "@/lib/billing-guard"
import { runRecurringBilling, BillingError } from "@/lib/billing/billing-engine"
import { runRenewalCycle } from "@/lib/billing/renewal-engine"

export const runtime = "nodejs"

/**
 * + Run a scheduled billing cycle: generate an invoice for
 * every active subscription whose current period is not yet invoiced, then run
 * one renewal-management pass (reconcile lifecycle, send due reminders, retry
 * failed renewal payments, escalate to suspension when exhausted). Both stages
 * are idempotent per (subscription, period) so re-running is safe.
 *
 * Pass `{ "renewals": false }` to run recurring billing only.
 */
export async function POST(request: Request) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  bindBillingTenant(session)
  try {
    const body = await request.json().catch(() => ({}))
    const taxRate = body.tax_rate == null ? 0 : Number(body.tax_rate)
    const rate = Number.isFinite(taxRate) ? taxRate : 0
    const result = await runRecurringBilling(session, { taxRate: rate })
    let renewals: Awaited<ReturnType<typeof runRenewalCycle>> | null = null
    if (body.renewals !== false) {
      renewals = await runRenewalCycle(session, {
        taxRate: rate,
        sendReminders: body.sendReminders !== false,
      })
    }
    return NextResponse.json({ ok: true, ...result, renewals })
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("[v0] POST /api/billing/run failed:", err)
    return NextResponse.json({ error: "Billing run failed" }, { status: 500 })
  }
}
