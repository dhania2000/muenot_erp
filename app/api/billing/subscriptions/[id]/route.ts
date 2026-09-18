import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import {
  getSubscriptionView,
  listEvents,
  updateSubscription,
  SubscriptionError,
} from "@/lib/billing/subscription-engine"

export const runtime = "nodejs"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const subscription = await getSubscriptionView(Number(id))
  if (!subscription) return NextResponse.json({ error: "Subscription not found" }, { status: 404 })
  const events = await listEvents(Number(id))
  return NextResponse.json({ subscription, events })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  try {
    const body = await request.json()
    const subscription = await updateSubscription(Number(id), body, session)
    return NextResponse.json({ ok: true, subscription })
  } catch (err) {
    if (err instanceof SubscriptionError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("[v0] PATCH /api/billing/subscriptions/[id] failed:", err)
    return NextResponse.json({ error: "Failed to update subscription" }, { status: 500 })
  }
}
