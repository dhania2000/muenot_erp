import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { listCoupons, createCoupon, BillingError } from "@/lib/billing/billing-engine"

export const runtime = "nodejs"

/** Coupons collection (tenant-scoped). */
export async function GET() {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    return NextResponse.json({ coupons: await listCoupons() })
  } catch (err) {
    console.error("[v0] GET /api/billing/coupons failed:", err)
    return NextResponse.json({ error: "Failed to load coupons" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const session = await billingGuard().catch(() => null)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const body = await request.json()
    const coupon = await createCoupon(body, session)
    return NextResponse.json({ ok: true, coupon }, { status: 201 })
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
    }
    console.error("[v0] POST /api/billing/coupons failed:", err)
    return NextResponse.json({ error: "Failed to create coupon" }, { status: 500 })
  }
}
