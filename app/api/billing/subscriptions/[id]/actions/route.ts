import { NextResponse } from "next/server"
import { billingGuard, bindBillingTenant } from "@/lib/billing-guard"
import {
  renewSubscription,
  cancelSubscription,
  suspendSubscription,
  resumeSubscription,
  SubscriptionError,
} from "@/lib/billing/subscription-engine"

export const runtime = "nodejs"

/**
 * Lifecycle actions on a single subscription:
 *   renew   — record a payment / extend by one term and restore access
 *   cancel  — cancel now, or schedule at period end ({ atPeriodEnd: true })
 *   suspend — admin block (e.g. compliance / non-payment escalation)
 *   resume  — lift a suspension
 * The subscription id is resolved through the tenant-scoped data layer, so an
 * action can never target another tenant's subscription (IDOR-safe).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  bindBillingTenant(session)
  const { id } = await params
  const subId = Number(id)

  try {
    const body = await request.json().catch(() => ({}))
    const action = String(body.action || "").toLowerCase()

    let subscription
    switch (action) {
      case "renew":
        subscription = await renewSubscription(subId, session, { note: body.note ?? null })
        break
      case "cancel":
        subscription = await cancelSubscription(subId, session, {
          atPeriodEnd: Boolean(body.atPeriodEnd),
          reason: body.reason ?? null,
        })
        break
      case "suspend":
        subscription = await suspendSubscription(subId, session, { reason: body.reason ?? null })
        break
      case "resume":
        subscription = await resumeSubscription(subId, session)
        break
      default:
        return NextResponse.json(
          { error: "Unknown action. Use one of: renew, cancel, suspend, resume." },
          { status: 400 },
        )
    }
    return NextResponse.json({ ok: true, subscription })
  } catch (err) {
    if (err instanceof SubscriptionError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("[v0] POST /api/billing/subscriptions/[id]/actions failed:", err)
    return NextResponse.json({ error: "Action failed" }, { status: 500 })
  }
}
