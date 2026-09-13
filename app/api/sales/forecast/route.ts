import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { computeForecast, createAdjustment } from "@/lib/sales/forecast-service"
import { ADJUSTMENT_TYPES, type AdjustmentType } from "@/lib/sales/forecast-model"

/**
 * GET /api/sales/forecast?fy=<startYear>&owner=<userId>
 *
 * Returns the fully computed quarterly forecast for a financial year, derived
 * live from real Sales + Finance records. Never returns hand-typed pipeline
 * numbers — only system-calculated figures plus any manager adjustments.
 */
export async function GET(request: Request) {
  const session = await requireFeature("sales.view_dashboard")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const fyParam = url.searchParams.get("fy")
  const ownerParam = url.searchParams.get("owner")

  const fyStartYear = fyParam ? Number(fyParam) : undefined
  const ownerId = ownerParam && ownerParam !== "all" ? Number(ownerParam) : null

  const forecast = await computeForecast({
    fyStartYear: Number.isFinite(fyStartYear) ? fyStartYear : undefined,
    ownerId: Number.isFinite(ownerId as number) ? ownerId : null,
  })

  return NextResponse.json(forecast)
}

/**
 * POST /api/sales/forecast
 *
 * Creates a MANUAL ADJUSTMENT or TARGET for a quarter. These are layered on top
 * of the system-calculated forecast, never a replacement for it, and require a
 * reason for traceability.
 */
export async function POST(request: Request) {
  const session = await requireFeature("sales.view_dashboard")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const fyStartYear = Number(body.fy_start_year)
  const quarter = Number(body.quarter)
  const type = body.adjustment_type as AdjustmentType
  const amount = Number(body.amount)
  const reason = typeof body.reason === "string" ? body.reason.trim() : ""
  const ownerId = body.owner_id != null && body.owner_id !== "" ? Number(body.owner_id) : null

  if (!Number.isFinite(fyStartYear)) {
    return NextResponse.json({ error: "A valid financial year is required" }, { status: 400 })
  }
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    return NextResponse.json({ error: "Quarter must be 1-4" }, { status: 400 })
  }
  if (!ADJUSTMENT_TYPES.includes(type)) {
    return NextResponse.json({ error: "Invalid adjustment type" }, { status: 400 })
  }
  if (!Number.isFinite(amount)) {
    return NextResponse.json({ error: "A valid amount is required" }, { status: 400 })
  }
  if (type === "Target" && amount < 0) {
    return NextResponse.json({ error: "Target cannot be negative" }, { status: 400 })
  }
  if (!reason) {
    return NextResponse.json({ error: "A reason is required for manual adjustments" }, { status: 400 })
  }

  const result = await createAdjustment(
    { fy_start_year: fyStartYear, quarter, adjustment_type: type, amount, owner_id: ownerId, reason },
    session.userId,
  )
  return NextResponse.json(result)
}
