import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { getPlan, updatePlan, SubscriptionError } from "@/lib/billing/subscription-engine"

export const runtime = "nodejs"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const plan = await getPlan(Number(id))
  if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 })
  return NextResponse.json({ plan })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  try {
    const body = await request.json()
    const plan = await updatePlan(Number(id), body)
    return NextResponse.json({ ok: true, plan })
  } catch (err) {
    if (err instanceof SubscriptionError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("[v0] PATCH /api/billing/plans/[id] failed:", err)
    return NextResponse.json({ error: "Failed to update plan" }, { status: 500 })
  }
}
