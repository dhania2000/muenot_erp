import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getProduct, updateProduct, ProductError } from "@/lib/products-db"
import { getProductSession, canViewProduct, canEditProduct, redactCost } from "@/lib/products-api-auth"
import { round2, num } from "@/lib/finance-calc"

export const runtime = "nodejs"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const pk = Number(id)

  const product = await getProduct(pk)
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 })
  if (!(await canViewProduct(ctx.session, product))) {
    return NextResponse.json({ error: "You do not have permission to view this product." }, { status: 403 })
  }

  // Margin is only computed when the user can see cost AND margin.
  const margin =
    ctx.caps.canViewCost && ctx.caps.canViewMargin && num(product.selling_price) > 0
      ? {
          amount: round2(num(product.selling_price) - num(product.cost_price)),
          percent: round2(((num(product.selling_price) - num(product.cost_price)) / num(product.selling_price)) * 100),
        }
      : null

  const [vendors, documents, priceHistory] = await Promise.all([
    query<any[]>(`SELECT * FROM product_vendors WHERE product_pk = ? ORDER BY is_preferred DESC, id DESC`, [pk]),
    query<any[]>(`SELECT * FROM product_documents WHERE product_pk = ? ORDER BY id DESC`, [pk]),
    query<any[]>(`SELECT * FROM product_price_history WHERE product_pk = ? ORDER BY changed_at DESC, id DESC LIMIT 100`, [pk]),
  ])

  return NextResponse.json({
    product: redactCost(product, ctx.caps),
    margin,
    vendors,
    documents,
    priceHistory: ctx.caps.canViewCost ? priceHistory : (priceHistory as any[]).filter((h) => h.field === "selling_price" || h.field === "mrp"),
    caps: ctx.caps,
  })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const pk = Number(id)

  const product = await getProduct(pk)
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 })
  if (!(await canEditProduct(ctx.session, product))) {
    return NextResponse.json({ error: "You do not have permission to edit this product." }, { status: 403 })
  }

  const body = await req.json()
  try {
    const updated = await updateProduct(pk, body, { userId: ctx.session.userId, userName: ctx.session.name })
    return NextResponse.json({ ok: true, product: redactCost(updated as any, ctx.caps) })
  } catch (error) {
    if (error instanceof ProductError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] product update failed:", (error as Error).message)
    return NextResponse.json({ error: "Failed to update product." }, { status: 500 })
  }
}
