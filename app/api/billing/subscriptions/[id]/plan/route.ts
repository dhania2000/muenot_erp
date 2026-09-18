import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { changeSubscriptionPlan, BillingError } from "@/lib/billing/billing-engine"

export const runtime = "nodejs"

/**
 * SPEC 25 — Self-service upgrade / downgrade from the customer portal.
 * Switches the subscription to a new plan (and optionally a new term),
 * applies proration (immediate prorated invoice on upgrade, account credit on
 * downgrade), and persists the change. The subscription id is resolved through
 * the tenant-scoped data layer, so it can never target another tenant (IDOR-safe).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const subscriptionId = Number(id)

  try {
    const body = await request.json().catch(() => ({}))
    const planId = Number(body.plan_id)
    if (!Number.isFinite(planId) || planId <= 0) {
      return NextResponse.json({ error: "A valid plan_id is required." }, { status: 400 })
    }

    const result = await changeSubscriptionPlan(
      { subscription_id: subscriptionId, plan_id: planId, term: body.term },
      session,
    )
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("[v0] POST /api/billing/subscriptions/[id]/plan failed:", err)
    return NextResponse.json({ error: "Failed to change plan" }, { status: 500 })
  }
}
