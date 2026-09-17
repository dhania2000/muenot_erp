import { NextRequest, NextResponse } from "next/server"
import {
  listProducts,
  createProduct,
  getProductMetrics,
  getFilterOptions,
  findDuplicates,
  ProductError,
} from "@/lib/products-db"
import { getProductSession, redactCost } from "@/lib/products-api-auth"

export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { caps } = ctx
  const p = req.nextUrl.searchParams

  const [list, metrics, filterOptions] = await Promise.all([
    listProducts({
      search: p.get("search") || undefined,
      category: p.get("category") || undefined,
      subcategory: p.get("subcategory") || undefined,
      brand: p.get("brand") || undefined,
      product_type: p.get("product_type") || undefined,
      status: p.get("status") || undefined,
      stock_status: p.get("stock_status") || undefined,
      gst_rate: p.get("gst_rate") || undefined,
      vendor: p.get("vendor") || undefined,
      sort: p.get("sort") || undefined,
      dir: (p.get("dir") as "asc" | "desc") || undefined,
      page: Number(p.get("page")) || 1,
      pageSize: Number(p.get("pageSize")) || 25,
    }),
    getProductMetrics(),
    getFilterOptions(),
  ])

  return NextResponse.json({
    ...list,
    rows: list.rows.map((r) => redactCost(r, caps)),
    metrics: caps.canViewCost ? metrics : { ...metrics, inventory_cost: null },
    filterOptions,
    caps,
  })
}

export async function POST(req: NextRequest) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!ctx.caps.canCreate) {
    return NextResponse.json({ error: "You do not have permission to add products." }, { status: 403 })
  }

  const body = await req.json()

  // Probable-duplicate warning (Phase 52) unless explicitly overridden.
  if (!body.allow_duplicate) {
    const dupes = await findDuplicates({ sku: body.sku, name: body.name, product_code: body.product_code })
    if (dupes.length > 0) {
      return NextResponse.json(
        {
          error: `A similar product already exists (${dupes.map((d) => d.product_id).join(", ")}). Confirm to add anyway.`,
          requiresOverride: "duplicate",
          duplicates: dupes,
        },
        { status: 409 },
      )
    }
  }

  try {
    const product = await createProduct(body, { userId: ctx.session.userId, userName: ctx.session.name })
    return NextResponse.json({ ok: true, product }, { status: 201 })
  } catch (error) {
    if (error instanceof ProductError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.log("[v0] product create failed:", (error as Error).message)
    return NextResponse.json({ error: "Failed to create product." }, { status: 500 })
  }
}
