import { NextRequest, NextResponse } from "next/server"
import { listProducts } from "@/lib/products-db"
import { getProductSession } from "@/lib/products-api-auth"

export const runtime = "nodejs"

function csvCell(v: any): string {
  if (v == null) return ""
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Export the (filtered) catalog to CSV — Phase 51. Cost columns only when permitted. */
export async function GET(req: NextRequest) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!ctx.caps.canImportExport) {
    return NextResponse.json({ error: "You do not have permission to export products." }, { status: 403 })
  }
  const p = req.nextUrl.searchParams
  const { rows } = await listProducts({
    search: p.get("search") || undefined,
    category: p.get("category") || undefined,
    product_type: p.get("product_type") || undefined,
    status: p.get("status") || undefined,
    stock_status: p.get("stock_status") || undefined,
    page: 1,
    pageSize: 200,
  })

  const baseCols = [
    "product_id", "name", "sku", "product_code", "category", "subcategory", "brand",
    "product_type", "unit", "hsn_sac", "gst_rate", "selling_price", "mrp",
  ]
  const costCols = ["purchase_price", "cost_price"]
  const stockCols = ["current_stock", "reorder_level", "min_stock", "stock_status", "status"]
  const cols = ctx.caps.canViewCost ? [...baseCols, ...costCols, ...stockCols] : [...baseCols, ...stockCols]

  const header = cols.join(",")
  const lines = rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))
  const csv = [header, ...lines].join("\n")

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="products-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
