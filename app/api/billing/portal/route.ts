import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { getActiveSubscription, listPlans, planPriceForTerm, type BillingTerm } from "@/lib/billing/subscription-engine"
import { listInvoices, listCredits, creditBalance, listTenantPayments } from "@/lib/billing/billing-engine"
import { getUsageOverview } from "@/lib/billing/usage-metering"
import { listGateways } from "@/lib/billing/gateways/registry"

export const runtime = "nodejs"

/**
 * SPEC 25 — Customer Billing Portal snapshot.
 * Composes everything a tenant admin needs to self-serve their subscription:
 * current plan, usage, billing cycle, invoices, payment methods, payment
 * history, renewal date, upgrade/downgrade options, cancellation state, and
 * credits. Every underlying engine is tenant-scoped, so this only ever returns
 * the caller's own tenant data (IDOR-safe). Admin-only via billingGuard.
 */
export async function GET() {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const [subscription, plans, invoices, payments, credits, balance, usage] = await Promise.all([
      getActiveSubscription(),
      listPlans({ activeOnly: true }),
      listInvoices(),
      listTenantPayments(50),
      listCredits(),
      creditBalance(),
      getUsageOverview({ trendDays: 30 }).catch(() => null),
    ])

    const currentTerm = (subscription?.term ?? "monthly") as BillingTerm

    // Upgrade/downgrade options — every active plan priced at the current term,
    // flagged relative to the plan the subscription is currently on.
    const currentAmount = subscription?.amount ?? 0
    const planOptions = plans.map((plan) => {
      const amount = planPriceForTerm(plan, currentTerm)
      const isCurrent = subscription?.plan_id === plan.id
      return {
        id: plan.id,
        plan_code: plan.plan_code,
        name: plan.name,
        description: plan.description,
        currency: plan.currency,
        amount,
        price_monthly: plan.price_monthly,
        price_yearly: plan.price_yearly,
        price_two_year: plan.price_two_year,
        price_five_year: plan.price_five_year,
        seats: plan.seats,
        trial_days: plan.trial_days,
        is_current: isCurrent,
        direction: isCurrent ? "current" : amount > currentAmount ? "upgrade" : "downgrade",
      }
    })

    return NextResponse.json({
      subscription,
      currentTerm,
      planOptions,
      invoices,
      payments,
      credits,
      creditBalance: balance,
      usage,
      paymentMethods: listGateways(),
    })
  } catch (err) {
    console.error("[v0] GET /api/billing/portal failed:", err)
    return NextResponse.json({ error: "Failed to load billing portal" }, { status: 500 })
  }
}
