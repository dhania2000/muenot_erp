import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getProduct } from "@/lib/products-db"
import { getProductSession } from "@/lib/products-api-auth"
import { applyStockMovement, InsufficientStockError } from "@/lib/products-inventory"
import { logProductAudit } from "@/lib/products-audit"
import { nextRecordId } from "@/lib/record-ids"
import { num } from "@/lib/finance-calc"

export const runtime = "nodejs"

/** GET the inventory ledger for a product (Phase 18 stock movement log). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const pk = Number(id)
  const ledger = await query<any[]>(
    `SELECT l.*, u.name AS user_name FROM inventory_ledger l
       LEFT JOIN users u ON u.id = l.user_id
       WHERE l.product_pk = ? ORDER BY l.created_at DESC, l.id DESC LIMIT 500`,
    [pk],
  )
  const adjustments = await query<any[]>(
    `SELECT a.*, u.name AS user_name FROM stock_adjustments a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.product_pk = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
    [pk],
  )
  return NextResponse.json({ ledger, adjustments })
}

/** POST a manual stock adjustment (increase / decrease / set) — Phase 17. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!ctx.caps.canAdjustStock) {
    return NextResponse.json({ error: "You do not have permission to adjust stock." }, { status: 403 })
  }
  const { id } = await params
  const pk = Number(id)
  const product = await getProduct(pk)
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 })
  if (Number(product.track_inventory) !== 1) {
    return NextResponse.json({ error: "This product type does not track inventory." }, { status: 400 })
  }

  const body = await req.json()
  const type = String(body.adjustment_type || "Increase")
  const value = num(body.quantity)
  if (!body.reason || !String(body.reason).trim()) {
    return NextResponse.json({ error: "A reason is required for every stock adjustment." }, { status: 400 })
  }
  if (value <= 0 && type !== "Set") {
    return NextResponse.json({ error: "Quantity must be greater than zero." }, { status: 400 })
  }

  const before = num(product.current_stock)
  let delta = 0
  if (type === "Increase") delta = value
  else if (type === "Decrease") delta = -value
  else if (type === "Set") delta = num(body.quantity) - before
  else return NextResponse.json({ error: "Invalid adjustment type." }, { status: 400 })

  const adjustmentId = await nextRecordId("LADJ", { digits: 4 })
  const movementDate = body.adjustment_date || new Date().toISOString().slice(0, 10)

  try {
    const res = await applyStockMovement({
      productPk: pk,
      quantity: delta,
      movementType: "Adjustment",
      movementDate,
      reference: adjustmentId,
      referenceType: "adjustment",
      referenceId: adjustmentId,
      unitCost: num(product.cost_price),
      notes: body.reason,
      userId: ctx.session.userId,
    })
    const after = res ? res.afterQty : before

    await query(
      `INSERT INTO stock_adjustments
         (adjustment_id, product_pk, product_id, adjustment_type, quantity, before_qty, after_qty, reason, reference, adjustment_date, user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [adjustmentId, pk, product.product_id, type, Math.abs(delta), before, after, body.reason, body.reference || null, movementDate, ctx.session.userId],
    )

    await logProductAudit({
      productPk: pk,
      productId: product.product_id,
      action: "stock_adjusted",
      field: "current_stock",
      oldValue: before,
      newValue: after,
      reason: body.reason,
      userId: ctx.session.userId,
      userName: ctx.session.name,
    })

    return NextResponse.json({ ok: true, adjustment_id: adjustmentId, before, after })
  } catch (error) {
    if (error instanceof InsufficientStockError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    console.log("[v0] stock adjustment failed:", (error as Error).message)
    return NextResponse.json({ error: "Failed to adjust stock." }, { status: 500 })
  }
}
