import { NextRequest, NextResponse } from "next/server"
import { createProduct, findProductBySku, ProductError } from "@/lib/products-db"
import { getProductSession } from "@/lib/products-api-auth"

export const runtime = "nodejs"

/**
 * Bulk import (Phase 51/52). Accepts an array of rows (parsed client-side from
 * CSV/XLSX). Each row is validated independently; the response reports per-row
 * outcome so the user sees exactly which rows were created and which were
 * skipped (duplicate SKU) or failed (validation) — no silent data loss.
 */
export async function POST(req: NextRequest) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!ctx.caps.canImportExport || !ctx.caps.canCreate) {
    return NextResponse.json({ error: "You do not have permission to import products." }, { status: 403 })
  }

  const body = await req.json()
  const rows: any[] = Array.isArray(body.rows) ? body.rows : []
  if (rows.length === 0) return NextResponse.json({ error: "No rows to import." }, { status: 400 })
  if (rows.length > 1000) return NextResponse.json({ error: "Import is limited to 1000 rows per batch." }, { status: 400 })

  const results: { row: number; status: "created" | "skipped" | "failed"; message?: string; product_id?: string }[] = []
  let created = 0
  let skipped = 0
  let failed = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    try {
      if (!row.name || !String(row.name).trim()) {
        results.push({ row: i + 1, status: "failed", message: "Missing product name" })
        failed++
        continue
      }
      if (row.sku) {
        const dup = await findProductBySku(String(row.sku).trim())
        if (dup) {
          results.push({ row: i + 1, status: "skipped", message: `SKU already exists (${dup.product_id})` })
          skipped++
          continue
        }
      }
      const product = await createProduct(
        { ...row, allow_duplicate: true },
        { userId: ctx.session.userId, userName: ctx.session.name },
      )
      results.push({ row: i + 1, status: "created", product_id: (product as any)?.product_id })
      created++
    } catch (error) {
      const msg = error instanceof ProductError ? error.message : "Failed to import row"
      results.push({ row: i + 1, status: "failed", message: msg })
      failed++
    }
  }

  return NextResponse.json({ ok: true, summary: { total: rows.length, created, skipped, failed }, results })
}
