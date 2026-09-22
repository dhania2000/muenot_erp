import "server-only"
import { query } from "@/lib/db"
import { currentTenantId } from "@/lib/tenant-scope"

/**
 * Shopkeeper product catalogue — tenant-owned.
 *
 * Separate from the ERP `products` table on purpose: that one is a global
 * catalogue with no tenant_id and an inventory/accounting shape the shop app
 * does not use. Every statement here derives the tenant from the request
 * context (lib/tenant-context.ts), never from caller input, so a mobile client
 * cannot address another tenant's rows even by guessing ids.
 */

export type ProductStatus = "active" | "inactive"
export type StockStatus = "in_stock" | "out_of_stock" | "low_stock"

export type ShopkeeperProduct = {
  id: number
  name: string
  sku: string | null
  category: string | null
  description: string | null
  price: number
  offerPrice: number | null
  currency: string
  imageUrl: string | null
  stockStatus: StockStatus
  stockQuantity: number | null
  status: ProductStatus
  createdAt: string
  updatedAt: string
}

export class ProductError extends Error {
  constructor(message: string, readonly status = 400, readonly fields?: Record<string, string>) {
    super(message)
    this.name = "ProductError"
  }
}

const STOCK: StockStatus[] = ["in_stock", "out_of_stock", "low_stock"]
const STATUS: ProductStatus[] = ["active", "inactive"]

function map(row: any): ShopkeeperProduct {
  return {
    id: Number(row.id),
    name: row.name,
    sku: row.sku,
    category: row.category,
    description: row.description,
    price: Number(row.price),
    offerPrice: row.offer_price === null ? null : Number(row.offer_price),
    currency: row.currency,
    imageUrl: row.image_url,
    stockStatus: row.stock_status,
    stockQuantity: row.stock_quantity === null ? null : Number(row.stock_quantity),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function money(value: unknown, field: string, fields: Record<string, string>): number | null {
  if (value === undefined || value === null || value === "") return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) {
    fields[field] = "Must be a number of 0 or more."
    return null
  }
  if (n > 99_999_999.99) {
    fields[field] = "Value is too large."
    return null
  }
  return Math.round(n * 100) / 100
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

type ProductInput = Record<string, unknown>

function validate(input: ProductInput, partial: boolean) {
  const fields: Record<string, string> = {}

  const name = text(input.name, 190)
  if (!partial && !name) fields.name = "Name is required."
  if (partial && input.name !== undefined && !name) fields.name = "Name cannot be empty."

  const price = money(input.price, "price", fields)
  if (!partial && input.price !== undefined && price === null && !fields.price) fields.price = "Invalid price."
  const offerPrice = money(input.offerPrice ?? input.offer_price, "offerPrice", fields)

  // An offer price above the list price is almost always a data-entry slip and
  // would silently overcharge, so reject rather than accept it.
  const effectivePrice = price ?? (typeof input.price === "number" ? Number(input.price) : null)
  if (offerPrice !== null && effectivePrice !== null && offerPrice > effectivePrice) {
    fields.offerPrice = "Offer price cannot be higher than the price."
  }

  if (input.status !== undefined && !STATUS.includes(String(input.status) as ProductStatus)) {
    fields.status = `Status must be one of: ${STATUS.join(", ")}.`
  }
  if (input.stockStatus !== undefined && !STOCK.includes(String(input.stockStatus) as StockStatus)) {
    fields.stockStatus = `Stock status must be one of: ${STOCK.join(", ")}.`
  }

  let stockQuantity: number | null = null
  const rawQty = input.stockQuantity ?? input.stock_quantity
  if (rawQty !== undefined && rawQty !== null && rawQty !== "") {
    const n = Number(rawQty)
    if (!Number.isInteger(n) || n < 0) fields.stockQuantity = "Stock quantity must be a whole number of 0 or more."
    else stockQuantity = n
  }

  if (Object.keys(fields).length) throw new ProductError("The product could not be saved.", 422, fields)
  return { name, price, offerPrice, stockQuantity }
}

export type ListProductsOptions = {
  search?: string
  category?: string
  status?: string
  limit?: number
  offset?: number
}

export async function listProducts(options: ListProductsOptions = {}) {
  const tenantId = currentTenantId()
  const where: string[] = ["tenant_id = ?"]
  const args: unknown[] = [tenantId]

  const search = text(options.search, 100)
  if (search) {
    where.push("(name LIKE ? OR sku LIKE ? OR category LIKE ?)")
    const like = `%${search}%`
    args.push(like, like, like)
  }
  const category = text(options.category, 120)
  if (category) {
    where.push("category = ?")
    args.push(category)
  }
  if (options.status && STATUS.includes(options.status as ProductStatus)) {
    where.push("status = ?")
    args.push(options.status)
  }

  const limit = Math.max(1, Math.min(200, Number(options.limit) || 50))
  const offset = Math.max(0, Number(options.offset) || 0)
  const clause = where.join(" AND ")

  const rows = await query<any[]>(
    `SELECT * FROM shopkeeper_products WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  )
  const [count] = await query<any[]>(
    `SELECT COUNT(*) AS total FROM shopkeeper_products WHERE ${clause}`,
    args,
  )
  return {
    products: rows.map(map),
    pagination: { limit, offset, total: Number(count?.total ?? 0) },
  }
}

export async function getProduct(id: number): Promise<ShopkeeperProduct | null> {
  if (!Number.isInteger(id) || id < 1) return null
  const rows = await query<any[]>(
    "SELECT * FROM shopkeeper_products WHERE id = ? AND tenant_id = ? LIMIT 1",
    [id, currentTenantId()],
  )
  return rows[0] ? map(rows[0]) : null
}

export async function createProduct(input: ProductInput, userId: number): Promise<ShopkeeperProduct> {
  const tenantId = currentTenantId()
  const { name, price, offerPrice, stockQuantity } = validate(input, false)
  const sku = text(input.sku, 64)
  if (sku) {
    const clash = await query<any[]>(
      "SELECT id FROM shopkeeper_products WHERE tenant_id = ? AND sku = ? LIMIT 1",
      [tenantId, sku],
    )
    if (clash.length) throw new ProductError("That SKU is already used.", 409, { sku: "Already in use." })
  }
  const result = (await query(
    `INSERT INTO shopkeeper_products
       (tenant_id, name, sku, category, description, price, offer_price, currency,
        image_url, stock_status, stock_quantity, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      tenantId,
      name,
      sku,
      text(input.category, 120),
      text(input.description, 5000),
      price ?? 0,
      offerPrice,
      text(input.currency, 8) || "INR",
      text(input.imageUrl ?? input.image_url, 500),
      STOCK.includes(String(input.stockStatus) as StockStatus) ? input.stockStatus : "in_stock",
      stockQuantity,
      STATUS.includes(String(input.status) as ProductStatus) ? input.status : "active",
      userId,
    ],
  )) as any
  const created = await getProduct(Number(result.insertId))
  if (!created) throw new ProductError("The product could not be read back after creation.", 500)
  return created
}

const PATCHABLE: Record<string, string> = {
  name: "name",
  sku: "sku",
  category: "category",
  description: "description",
  price: "price",
  offerPrice: "offer_price",
  currency: "currency",
  imageUrl: "image_url",
  stockStatus: "stock_status",
  stockQuantity: "stock_quantity",
  status: "status",
}

export async function updateProduct(id: number, input: ProductInput): Promise<ShopkeeperProduct> {
  const tenantId = currentTenantId()
  const existing = await getProduct(id)
  if (!existing) throw new ProductError("Product not found.", 404)

  // Validate the merged result, so a partial patch cannot produce an offer
  // price above a price it did not send.
  validate({ price: existing.price, offerPrice: existing.offerPrice, ...input }, true)

  const sku = input.sku !== undefined ? text(input.sku, 64) : undefined
  if (sku) {
    const clash = await query<any[]>(
      "SELECT id FROM shopkeeper_products WHERE tenant_id = ? AND sku = ? AND id <> ? LIMIT 1",
      [tenantId, sku, id],
    )
    if (clash.length) throw new ProductError("That SKU is already used.", 409, { sku: "Already in use." })
  }

  const sets: string[] = []
  const args: unknown[] = []
  for (const [key, column] of Object.entries(PATCHABLE)) {
    if (input[key] === undefined) continue
    let value: unknown = input[key]
    if (key === "price" || key === "offerPrice") value = value === null ? null : Number(value)
    else if (key === "stockQuantity") value = value === null || value === "" ? null : Number(value)
    else if (typeof value === "string") value = text(value, key === "description" ? 5000 : 500)
    sets.push(`\`${column}\` = ?`)
    args.push(value)
  }
  if (sets.length) {
    await query(`UPDATE shopkeeper_products SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`, [
      ...args,
      id,
      tenantId,
    ])
  }
  return (await getProduct(id))!
}

export async function deleteProduct(id: number): Promise<boolean> {
  const tenantId = currentTenantId()
  const existing = await getProduct(id)
  if (!existing) return false
  // Orders keep their own copy of name/price and reference products with
  // ON DELETE SET NULL, so removing a product never rewrites order history.
  await query("DELETE FROM shopkeeper_products WHERE id = ? AND tenant_id = ?", [id, tenantId])
  return true
}

export async function listCategories(): Promise<string[]> {
  const rows = await query<any[]>(
    "SELECT DISTINCT category FROM shopkeeper_products WHERE tenant_id = ? AND category IS NOT NULL ORDER BY category",
    [currentTenantId()],
  )
  return rows.map((r) => r.category)
}
