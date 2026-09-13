import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { deleteAdjustment, updateAdjustment } from "@/lib/sales/forecast-service"
import { ADJUSTMENT_TYPES, type AdjustmentType } from "@/lib/sales/forecast-model"

/**
 * PATCH/DELETE operate on a manual forecast ADJUSTMENT (not on the computed
 * forecast, which has no editable rows). Every change is audited.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.view_dashboard")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json().catch(() => ({}))

  const patch: {
    amount?: number
    reason?: string
    adjustment_type?: AdjustmentType
    owner_id?: number | null
    quarter?: number
  } = {}

  if (body.amount != null && body.amount !== "") {
    const amount = Number(body.amount)
    if (!Number.isFinite(amount)) return NextResponse.json({ error: "Invalid amount" }, { status: 400 })
    patch.amount = amount
  }
  if (typeof body.reason === "string") {
    const reason = body.reason.trim()
    if (!reason) return NextResponse.json({ error: "Reason cannot be empty" }, { status: 400 })
    patch.reason = reason
  }
  if (body.adjustment_type != null) {
    if (!ADJUSTMENT_TYPES.includes(body.adjustment_type)) {
      return NextResponse.json({ error: "Invalid adjustment type" }, { status: 400 })
    }
    patch.adjustment_type = body.adjustment_type
  }
  if ("owner_id" in body) patch.owner_id = body.owner_id != null && body.owner_id !== "" ? Number(body.owner_id) : null
  if (body.quarter != null) {
    const q = Number(body.quarter)
    if (!Number.isInteger(q) || q < 1 || q > 4) return NextResponse.json({ error: "Quarter must be 1-4" }, { status: 400 })
    patch.quarter = q
  }

  await updateAdjustment(Number(id), patch, session.userId)
  return NextResponse.json({ success: true })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.view_dashboard")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  await deleteAdjustment(Number(id), session.userId)
  return NextResponse.json({ success: true })
}
