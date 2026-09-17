import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureProductSchema } from "@/lib/products-ensure"
import { stockStatusExpr } from "@/lib/products-db"

export const runtime = "nodejs"

/**
 * Lightweight product picker used by Sales Invoice and Purchase Bill line
 * editors. Only active products are selectable; each result carries the pricing
 * and tax metadata a document line needs so selecting a product auto-fills the
 * rate, HSN/SAC and GST rate (Phases 31/34).
 */
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureProductSchema()

  const search = req.nextUrl.searchParams.get("search") || ""
  const context = req.nextUrl.searchParams.get("context") || "sales" // 'sales' | 'purchase'

  const priceCol = context === "purchase" ? "p.purchase_price" : "p.selling_price"

  const rows = await query<any[]>(
    `SELECT p.id, p.product_id, p.name, p.sku, p.unit, p.hsn_sac, p.gst_applicable, p.gst_rate,
            p.selling_price, p.purchase_price, p.mrp, p.product_type, p.track_inventory,
            p.current_stock, ${priceCol} AS suggested_rate, ${stockStatusExpr("p")} AS stock_status
       FROM products p
       WHERE p.status = 'Active'
         AND (? = '' OR p.name LIKE ? OR p.sku LIKE ? OR p.product_id LIKE ? OR p.hsn_sac LIKE ?)
       ORDER BY p.name ASC
       LIMIT 50`,
    [search, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`],
  )
  return NextResponse.json({ products: rows })
}
