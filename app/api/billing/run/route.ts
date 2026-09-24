import { NextResponse } from "next/server"
import { billingGuard, bindBillingTenant } from "@/lib/billing-guard"
import { runRecurringBilling, BillingError } from "@/lib/billing/billing-engine"
import { runRenewalCycle } from "@/lib/billing/renewal-engine"
import { listSubscriptions } from "@/lib/billing/subscription-engine"
import { reconcileSubscriptionUsage } from "@/lib/billing/usage-invoicing"

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

    // Usage-based billing: reconcile metered overage for every live
    // subscription into one invoice line per metric. Idempotent per
    // (subscription, period, meter) via the usage_billing_ledger, so re-running
    // never double charges. Pass `{ "usage": false }` to skip.
    let usage: {
      subscriptionsReconciled: number
      invoicesCreated: number
      overageBilled: number
    } | null = null
    if (body.usage !== false) {
      const subs = await listSubscriptions()
      const live = subs.filter((s) => s.status !== "cancelled" && s.status !== "expired")
      let invoicesCreated = 0
      let overageBilled = 0
      for (const s of live) {
        try {
          const r = await reconcileSubscriptionUsage(s.id, session)
          if (!r.noop) {
            invoicesCreated++
            overageBilled += r.total
          }
        } catch (e) {
          console.error(`[v0] usage reconciliation failed for subscription ${s.id}:`, e)
        }
      }
      usage = {
        subscriptionsReconciled: live.length,
        invoicesCreated,
        overageBilled: Math.round(overageBilled * 100) / 100,
      }
    }

    let renewals: Awaited<ReturnType<typeof runRenewalCycle>> | null = null
    if (body.renewals !== false) {
      renewals = await runRenewalCycle(session, {
        taxRate: rate,
        sendReminders: body.sendReminders !== false,
      })
    }
    return NextResponse.json({ ok: true, ...result, usage, renewals })
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("[v0] POST /api/billing/run failed:", err)
    return NextResponse.json({ error: "Billing run failed" }, { status: 500 })
  }
}
