import { NextResponse } from "next/server"
import { billingGuard, bindBillingTenant } from "@/lib/billing-guard"
import {
  listSubscriptions,
  getSummary,
  subscribe,
  SubscriptionError,
} from "@/lib/billing/subscription-engine"

export const runtime = "nodejs"

/**
 * Tenant subscriptions. Reads are scoped to the acting tenant by the
 * tenant-scope data layer; a client can never see another tenant's
 * subscription. billingGuard enforces an authenticated admin session.
 */

export async function GET() {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  bindBillingTenant(session)
  try {
    const [subscriptions, summary] = await Promise.all([listSubscriptions(), getSummary()])
    return NextResponse.json({ subscriptions, summary })
  } catch (err) {
    console.error("[v0] GET /api/billing/subscriptions failed:", err)
    return NextResponse.json({ error: "Failed to load subscriptions" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  bindBillingTenant(session)
  try {
    const body = await request.json()
    const subscription = await subscribe(body, session)
    return NextResponse.json({ ok: true, subscription }, { status: 201 })
  } catch (err) {
    if (err instanceof SubscriptionError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("[v0] POST /api/billing/subscriptions failed:", err)
    return NextResponse.json({ error: "Failed to create subscription" }, { status: 500 })
  }
}
