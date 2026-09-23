import { NextResponse } from "next/server"
import { billingGuard } from "@/lib/billing-guard"
import { getMeter, setUsageLimit, clearUsageLimit, type LimitPeriod } from "@/lib/billing/usage-metering"

export const runtime = "nodejs"

const PERIODS: LimitPeriod[] = ["month", "day", "none"]

/**
 * Configure per-tenant usage quotas. Admin-only. Tenant is derived
 * from the session, so a request can only ever set its own organisation's
 * limits.
 */
export async function PUT(request: Request) {
  await billingGuard()

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const meterKey = String(body?.meterKey ?? "")
  if (!getMeter(meterKey)) return NextResponse.json({ error: "Unknown meter" }, { status: 400 })

  const limitValue = Number(body?.limitValue)
  if (!Number.isFinite(limitValue) || limitValue < 0) {
    return NextResponse.json({ error: "limitValue must be a non-negative number" }, { status: 400 })
  }

  const period: LimitPeriod = PERIODS.includes(body?.period) ? body.period : "month"

  try {
    await setUsageLimit({
      meterKey,
      limitValue,
      period,
      hardLimit: Boolean(body?.hardLimit),
      isActive: body?.isActive !== false,
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[v0] set usage limit failed:", err)
    return NextResponse.json({ error: (err as Error).message || "Failed to set limit" }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  await billingGuard()
  const { searchParams } = new URL(request.url)
  const meterKey = String(searchParams.get("meterKey") ?? "")
  if (!getMeter(meterKey)) return NextResponse.json({ error: "Unknown meter" }, { status: 400 })
  try {
    await clearUsageLimit(meterKey)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[v0] clear usage limit failed:", err)
    return NextResponse.json({ error: "Failed to clear limit" }, { status: 500 })
  }
}
