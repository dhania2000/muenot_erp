import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { listPlans, createPlan, SubscriptionError } from "@/lib/billing/subscription-engine"

export const runtime = "nodejs"

/**
 * SaaS plan catalogue. Plans are a global catalogue configured by
 * platform admins; every tenant subscribes against them. billingGuard enforces
 * an authenticated admin session (mirrors the rest of the billing module).
 */

export async function GET(request: Request) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const url = new URL(request.url)
  const activeOnly = url.searchParams.get("activeOnly") === "1"
  try {
    const plans = await listPlans({ activeOnly })
    return NextResponse.json({ plans })
  } catch (err) {
    console.error("[v0] GET /api/billing/plans failed:", err)
    return NextResponse.json({ error: "Failed to load plans" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const body = await request.json()
    const plan = await createPlan(body, session)
    return NextResponse.json({ ok: true, plan }, { status: 201 })
  } catch (err) {
    if (err instanceof SubscriptionError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("[v0] POST /api/billing/plans failed:", err)
    return NextResponse.json({ error: "Failed to create plan" }, { status: 500 })
  }
}
