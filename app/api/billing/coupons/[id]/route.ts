import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { setCouponActive, BillingError } from "@/lib/billing/billing-engine"

export const runtime = "nodejs"

/** Enable/disable a coupon. Tenant-scoped ownership check inside. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  try {
    const body = await request.json().catch(() => ({}))
    await setCouponActive(Number(id), Boolean(body.is_active))
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("[v0] PATCH /api/billing/coupons/[id] failed:", err)
    return NextResponse.json({ error: "Failed to update coupon" }, { status: 500 })
  }
}
