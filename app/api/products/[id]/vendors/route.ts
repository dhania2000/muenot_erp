import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getProduct } from "@/lib/products-db"
import { getProductSession, canEditProduct } from "@/lib/products-api-auth"
import { num } from "@/lib/finance-calc"

export const runtime = "nodejs"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const vendors = await query<any[]>(
    `SELECT * FROM product_vendors WHERE product_pk = ? ORDER BY is_preferred DESC, id DESC`,
    [Number(id)],
  )
  return NextResponse.json({ vendors })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  if (!body.vendor_id) return NextResponse.json({ error: "vendor_id is required" }, { status: 400 })

  await query(
    `INSERT INTO product_vendors (product_pk, vendor_id, vendor_name, vendor_price, is_preferred)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE vendor_name = VALUES(vendor_name), vendor_price = VALUES(vendor_price), is_preferred = VALUES(is_preferred)`,
    [pk, String(body.vendor_id), body.vendor_name || null, num(body.vendor_price), body.is_preferred ? 1 : 0],
  )

  // A newly-flagged preferred vendor becomes THE preferred vendor.
  if (body.is_preferred) {
    await query(`UPDATE product_vendors SET is_preferred = 0 WHERE product_pk = ? AND vendor_id <> ?`, [pk, String(body.vendor_id)])
    await query(`UPDATE products SET preferred_vendor_id = ?, preferred_vendor_name = ? WHERE id = ?`, [
      String(body.vendor_id),
      body.vendor_name || null,
      pk,
    ])
  }

  const vendors = await query<any[]>(`SELECT * FROM product_vendors WHERE product_pk = ? ORDER BY is_preferred DESC, id DESC`, [pk])
  return NextResponse.json({ ok: true, vendors })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const pk = Number(id)
  const product = await getProduct(pk)
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 })
  if (!(await canEditProduct(ctx.session, product))) {
    return NextResponse.json({ error: "You do not have permission to edit this product." }, { status: 403 })
  }
  const vendorId = req.nextUrl.searchParams.get("vendor_id")
  if (!vendorId) return NextResponse.json({ error: "vendor_id is required" }, { status: 400 })
  await query(`DELETE FROM product_vendors WHERE product_pk = ? AND vendor_id = ?`, [pk, vendorId])
  return NextResponse.json({ ok: true })
}
