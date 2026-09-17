import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { ensureProductSchema } from "@/lib/products-ensure"
import { getProductSession } from "@/lib/products-api-auth"

export const runtime = "nodejs"

export async function GET() {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureProductSchema()
  const categories = await query<any[]>(
    `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category = c.name) AS product_count
       FROM product_categories c ORDER BY c.parent IS NOT NULL, c.name`,
  )
  return NextResponse.json({ categories })
}

export async function POST(req: NextRequest) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!ctx.caps.canManageCategories) {
    return NextResponse.json({ error: "You do not have permission to manage categories." }, { status: 403 })
  }
  await ensureProductSchema()
  const body = await req.json()
  const name = String(body.name || "").trim()
  if (!name) return NextResponse.json({ error: "Category name is required." }, { status: 400 })
  try {
    await query(
      `INSERT INTO product_categories (name, parent, description, created_by) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE description = VALUES(description), status = 'Active'`,
      [name, body.parent || null, body.description || null, ctx.session.userId],
    )
  } catch (error) {
    return NextResponse.json({ error: "Failed to save category." }, { status: 500 })
  }
  const categories = await query<any[]>(`SELECT * FROM product_categories ORDER BY parent IS NOT NULL, name`)
  return NextResponse.json({ ok: true, categories })
}

export async function DELETE(req: NextRequest) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!ctx.caps.canManageCategories) {
    return NextResponse.json({ error: "You do not have permission to manage categories." }, { status: 403 })
  }
  const id = Number(req.nextUrl.searchParams.get("id"))
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 })
  // Retire rather than hard-delete so historical products keep their label.
  await query(`UPDATE product_categories SET status = 'Inactive' WHERE id = ?`, [id])
  return NextResponse.json({ ok: true })
}
