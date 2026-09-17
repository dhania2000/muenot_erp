import "server-only"
import { query } from "@/lib/db"
import { num, round2 } from "@/lib/finance-calc"
import { nextRecordId } from "@/lib/record-ids"
import { ensureProductSchema } from "@/lib/products-ensure"
import { logProductAudit } from "@/lib/products-audit"
import { applyStockMovement } from "@/lib/products-inventory"

export const PRODUCT_TYPES = ["Goods", "Service", "Subscription", "Digital", "Non-Stock", "Other"] as const
export const NON_STOCK_TYPES = new Set(["Service", "Subscription", "Digital", "Non-Stock"])
export const UNITS = ["Nos", "Kg", "Gram", "Liter", "Meter", "Hour", "Day", "Month", "Year", "Box", "Piece", "Set", "Custom"] as const
export const STATUSES = ["Active", "Inactive", "Discontinued"] as const
export const PRICE_FIELDS = ["purchase_price", "cost_price", "selling_price", "mrp"] as const

export type ProductSettings = {
  low_stock_threshold: string
  negative_stock_allowed: string
  default_unit: string
  default_gst_rate: string
  default_valuation: string
}

export async function getProductSettings(): Promise<ProductSettings> {
  await ensureProductSchema()
  const rows = (await query<any[]>(`SELECT setting_key, setting_value FROM product_settings`)) as any[]
  const map: any = {}
  for (const r of rows) map[r.setting_key] = r.setting_value
  return {
    low_stock_threshold: map.low_stock_threshold ?? "0",
    negative_stock_allowed: map.negative_stock_allowed ?? "0",
    default_unit: map.default_unit ?? "Nos",
    default_gst_rate: map.default_gst_rate ?? "18",
    default_valuation: map.default_valuation ?? "Weighted Average",
  }
}

export async function updateProductSettings(patch: Partial<ProductSettings>, userId?: number | null) {
  await ensureProductSchema()
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) continue
    await query(
      `INSERT INTO product_settings (setting_key, setting_value, updated_by) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
      [k, String(v), userId ?? null],
    )
  }
  return getProductSettings()
}

/** Derived stock status (Phases 21/22/83). Lifecycle status is separate. */
export function stockStatusExpr(alias = "p"): string {
  return `CASE
    WHEN ${alias}.track_inventory = 0 THEN 'In Stock'
    WHEN ${alias}.current_stock <= 0 THEN 'Out of Stock'
    WHEN ${alias}.reorder_level > 0 AND ${alias}.current_stock <= ${alias}.reorder_level THEN 'Low Stock'
    WHEN ${alias}.min_stock > 0 AND ${alias}.current_stock <= ${alias}.min_stock THEN 'Low Stock'
    ELSE 'In Stock' END`
}

export type ProductListParams = {
  search?: string
  category?: string
  subcategory?: string
  brand?: string
  product_type?: string
  status?: string
  stock_status?: string
  gst_rate?: string
  vendor?: string
  includeInactive?: boolean
  sort?: string
  dir?: "asc" | "desc"
  page?: number
  pageSize?: number
}

const SORT_COLUMNS: Record<string, string> = {
  name: "p.name",
  sku: "p.sku",
  price: "p.selling_price",
  stock: "p.current_stock",
  created: "p.created_at",
  updated: "p.updated_at",
}

export async function listProducts(params: ProductListParams) {
  await ensureProductSchema()
  const conditions: string[] = []
  const args: any[] = []
  const add = (cond: string, ...vals: any[]) => {
    conditions.push(cond)
    args.push(...vals)
  }

  if (params.search) {
    add(
      "(p.name LIKE ? OR p.sku LIKE ? OR p.product_id LIKE ? OR p.product_code LIKE ? OR p.category LIKE ? OR p.brand LIKE ? OR p.hsn_sac LIKE ?)",
      ...Array(7).fill(`%${params.search}%`),
    )
  }
  if (params.category) add("p.category = ?", params.category)
  if (params.subcategory) add("p.subcategory = ?", params.subcategory)
  if (params.brand) add("p.brand = ?", params.brand)
  if (params.product_type) add("p.product_type = ?", params.product_type)
  if (params.status) add("p.status = ?", params.status)
  else if (!params.includeInactive) {
    // Default list still shows all lifecycle states; explicit filter narrows it.
  }
  if (params.gst_rate) add("p.gst_rate = ?", Number(params.gst_rate))
  if (params.vendor) add("p.preferred_vendor_id = ?", params.vendor)
  if (params.stock_status) add(`${stockStatusExpr("p")} = ?`, params.stock_status)

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""

  const sortCol = SORT_COLUMNS[params.sort || "created"] || "p.created_at"
  const dir = params.dir === "asc" ? "ASC" : "DESC"

  const page = Math.max(1, Number(params.page) || 1)
  const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 25))
  const offset = (page - 1) * pageSize

  const rows = (await query<any[]>(
    `SELECT p.*, ${stockStatusExpr("p")} AS stock_status,
            (p.current_stock - p.reserved_stock) AS available_stock,
            u.name AS created_by_name
       FROM products p
       LEFT JOIN users u ON u.id = p.created_by
       ${where}
       ORDER BY ${sortCol} ${dir}, p.id DESC
       LIMIT ? OFFSET ?`,
    [...args, pageSize, offset],
  )) as any[]

  const [count] = (await query<any[]>(
    `SELECT COUNT(*) AS total FROM products p ${where}`,
    args,
  )) as any[]

  return {
    rows,
    total: Number(count?.total || 0),
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(Number(count?.total || 0) / pageSize)),
  }
}

export async function getProduct(pk: number): Promise<Record<string, any> | null> {
  await ensureProductSchema()
  const [row] = (await query<any[]>(
    `SELECT p.*, ${stockStatusExpr("p")} AS stock_status,
            (p.current_stock - p.reserved_stock) AS available_stock,
            u.name AS created_by_name
       FROM products p LEFT JOIN users u ON u.id = p.created_by
       WHERE p.id = ? LIMIT 1`,
    [pk],
  )) as any[]
  return row || null
}

export async function findProductBySku(sku: string): Promise<Record<string, any> | null> {
  if (!sku) return null
  const [row] = (await query<any[]>(`SELECT * FROM products WHERE sku = ? LIMIT 1`, [sku])) as any[]
  return row || null
}

/** Probable-duplicate detection (Phase 52) on SKU / name / product_code. */
export async function findDuplicates(input: {
  sku?: string | null
  name?: string | null
  product_code?: string | null
  excludePk?: number
}): Promise<Record<string, any>[]> {
  const conds: string[] = []
  const args: any[] = []
  if (input.sku) {
    conds.push("p.sku = ?")
    args.push(input.sku)
  }
  if (input.name) {
    conds.push("p.name = ?")
    args.push(input.name)
  }
  if (input.product_code) {
    conds.push("p.product_code = ?")
    args.push(input.product_code)
  }
  if (conds.length === 0) return []
  let where = `(${conds.join(" OR ")})`
  if (input.excludePk) {
    where += " AND p.id <> ?"
    args.push(input.excludePk)
  }
  return (await query<any[]>(
    `SELECT id, product_id, name, sku, product_code, status FROM products p WHERE ${where} LIMIT 10`,
    args,
  )) as any[]
}

const NUMERIC_FIELDS = new Set([
  "gst_rate", "purchase_price", "cost_price", "selling_price", "mrp",
  "opening_stock", "min_stock", "reorder_level", "reorder_quantity", "max_stock",
])
const BOOL_FIELDS = new Set(["gst_applicable", "price_inclusive"])

const WRITABLE_FIELDS = [
  "name", "sku", "product_code", "category", "subcategory", "brand", "description",
  "product_type", "unit", "hsn_sac", "gst_applicable", "gst_rate", "tax_type",
  "price_inclusive", "purchase_price", "cost_price", "selling_price", "mrp",
  "min_stock", "reorder_level", "reorder_quantity", "max_stock", "valuation_method",
  "preferred_vendor_id", "preferred_vendor_name", "sales_account", "purchase_account",
  "inventory_account", "image_url",
]

function normalizeValue(field: string, value: any): any {
  if (BOOL_FIELDS.has(field)) return value ? 1 : 0
  if (NUMERIC_FIELDS.has(field)) return num(value)
  if (value === "" || value === undefined) return null
  return value
}

export type CreateProductInput = Record<string, any> & {
  name: string
  opening_stock?: any
}

export async function createProduct(input: CreateProductInput, actor: { userId?: number | null; userName?: string | null }) {
  await ensureProductSchema()

  const name = String(input.name || "").trim()
  if (!name) throw new ProductError("Product Name is required.", 400)

  const sku = input.sku ? String(input.sku).trim() : null
  if (sku) {
    const existing = await findProductBySku(sku)
    if (existing) throw new ProductError(`SKU "${sku}" is already used by ${existing.product_id}.`, 409)
  }

  const productType = PRODUCT_TYPES.includes(input.product_type) ? input.product_type : "Goods"
  const trackInventory = NON_STOCK_TYPES.has(productType) ? 0 : 1

  const record: Record<string, any> = {}
  for (const field of WRITABLE_FIELDS) {
    if (input[field] !== undefined) record[field] = normalizeValue(field, input[field])
  }
  record.name = name
  record.sku = sku
  record.product_type = productType
  record.track_inventory = trackInventory
  record.status = STATUSES.includes(input.status) ? input.status : "Active"

  const openingStock = trackInventory ? num(input.opening_stock) : 0
  record.opening_stock = openingStock
  record.current_stock = 0 // set through the ledger below

  const productId = await nextRecordId("PROD", { digits: 4 })
  record.product_id = productId
  record.created_by = actor.userId ?? null

  const cols = Object.keys(record)
  const result = (await query(
    `INSERT INTO products (${cols.map((c) => `\`${c}\``).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    cols.map((c) => record[c]),
  )) as any
  const pk = Number(result.insertId)

  // Opening stock is posted through the ledger, never as a bare number.
  if (openingStock > 0) {
    await applyStockMovement({
      productPk: pk,
      quantity: openingStock,
      movementType: "Opening",
      reference: "Opening Stock",
      referenceType: "opening",
      referenceId: productId,
      unitCost: num(record.cost_price),
      userId: actor.userId,
      allowNegative: true,
    })
  }

  // Seed price history baseline for any non-zero price.
  for (const pf of PRICE_FIELDS) {
    const v = num(record[pf])
    if (v > 0) {
      await query(
        `INSERT INTO product_price_history (product_pk, product_id, field, old_price, new_price, reason, changed_by)
         VALUES (?,?,?,?,?,?,?)`,
        [pk, productId, pf, 0, v, "Initial price", actor.userId ?? null],
      )
    }
  }

  await logProductAudit({
    productPk: pk,
    productId,
    action: "created",
    newValue: name,
    userId: actor.userId,
    userName: actor.userName,
  })

  return getProduct(pk)
}

export async function updateProduct(
  pk: number,
  input: Record<string, any>,
  actor: { userId?: number | null; userName?: string | null },
) {
  await ensureProductSchema()
  const current = await getProduct(pk)
  if (!current) throw new ProductError("Product not found.", 404)

  // SKU uniqueness on change.
  if (input.sku !== undefined) {
    const newSku = input.sku ? String(input.sku).trim() : null
    if (newSku && newSku !== current.sku) {
      const dup = await findProductBySku(newSku)
      if (dup && Number(dup.id) !== pk) throw new ProductError(`SKU "${newSku}" is already used by ${dup.product_id}.`, 409)
    }
  }

  const updates: Record<string, any> = {}
  for (const field of WRITABLE_FIELDS) {
    if (input[field] === undefined) continue
    updates[field] = normalizeValue(field, input[field])
  }

  // Product type change flips inventory tracking.
  if (input.product_type !== undefined && PRODUCT_TYPES.includes(input.product_type)) {
    updates.product_type = input.product_type
    updates.track_inventory = NON_STOCK_TYPES.has(input.product_type) ? 0 : 1
  }

  if (Object.keys(updates).length === 0) return current

  // Price change history + audit (Phase 14).
  for (const pf of PRICE_FIELDS) {
    if (updates[pf] === undefined) continue
    const oldP = num(current[pf])
    const newP = num(updates[pf])
    if (round2(oldP) !== round2(newP)) {
      await query(
        `INSERT INTO product_price_history (product_pk, product_id, field, old_price, new_price, reason, changed_by)
         VALUES (?,?,?,?,?,?,?)`,
        [pk, current.product_id, pf, oldP, newP, input.price_change_reason || null, actor.userId ?? null],
      )
      await logProductAudit({
        productPk: pk,
        productId: current.product_id,
        action: "price_changed",
        field: pf,
        oldValue: oldP,
        newValue: newP,
        reason: input.price_change_reason || null,
        userId: actor.userId,
        userName: actor.userName,
      })
    }
  }

  const cols = Object.keys(updates)
  await query(
    `UPDATE products SET ${cols.map((c) => `\`${c}\` = ?`).join(", ")} WHERE id = ?`,
    [...cols.map((c) => updates[c]), pk],
  )

  await logProductAudit({
    productPk: pk,
    productId: current.product_id,
    action: "updated",
    field: cols.join(", "),
    userId: actor.userId,
    userName: actor.userName,
  })

  return getProduct(pk)
}

/** Lifecycle status change (activate / deactivate / discontinue). Never hard-deletes. */
export async function changeProductStatus(
  pk: number,
  status: string,
  actor: { userId?: number | null; userName?: string | null },
  reason?: string,
) {
  await ensureProductSchema()
  if (!STATUSES.includes(status as any)) throw new ProductError("Invalid status.", 400)
  const current = await getProduct(pk)
  if (!current) throw new ProductError("Product not found.", 404)
  await query(`UPDATE products SET status = ? WHERE id = ?`, [status, pk])
  const actionMap: Record<string, string> = {
    Active: "activated",
    Inactive: "deactivated",
    Discontinued: "discontinued",
  }
  await logProductAudit({
    productPk: pk,
    productId: current.product_id,
    action: actionMap[status] || "status_changed",
    field: "status",
    oldValue: current.status,
    newValue: status,
    reason: reason || null,
    userId: actor.userId,
    userName: actor.userName,
  })
  return getProduct(pk)
}

/** Dashboard metrics — all live from the database (Phases 41/42/43). */
export async function getProductMetrics() {
  await ensureProductSchema()
  const [m] = (await query<any[]>(
    `SELECT
       COUNT(*) AS total_products,
       SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) AS active_products,
       SUM(CASE WHEN status = 'Inactive' THEN 1 ELSE 0 END) AS inactive_products,
       SUM(CASE WHEN status = 'Discontinued' THEN 1 ELSE 0 END) AS discontinued_products,
       SUM(CASE WHEN track_inventory = 1 AND current_stock > 0
                 AND NOT (reorder_level > 0 AND current_stock <= reorder_level)
                 AND NOT (min_stock > 0 AND current_stock <= min_stock)
            THEN 1 ELSE 0 END) AS in_stock,
       SUM(CASE WHEN track_inventory = 1 AND current_stock > 0
                 AND ((reorder_level > 0 AND current_stock <= reorder_level)
                   OR (min_stock > 0 AND current_stock <= min_stock))
            THEN 1 ELSE 0 END) AS low_stock,
       SUM(CASE WHEN track_inventory = 1 AND current_stock <= 0 THEN 1 ELSE 0 END) AS out_of_stock,
       COALESCE(SUM(current_stock * cost_price), 0) AS inventory_cost,
       COALESCE(SUM(current_stock * selling_price), 0) AS stock_value
     FROM products`,
  )) as any[]
  return {
    total_products: Number(m?.total_products || 0),
    active_products: Number(m?.active_products || 0),
    inactive_products: Number(m?.inactive_products || 0),
    discontinued_products: Number(m?.discontinued_products || 0),
    in_stock: Number(m?.in_stock || 0),
    low_stock: Number(m?.low_stock || 0),
    out_of_stock: Number(m?.out_of_stock || 0),
    inventory_cost: round2(Number(m?.inventory_cost || 0)),
    stock_value: round2(Number(m?.stock_value || 0)),
  }
}

/** Distinct filter option lists, all sourced from real data. */
export async function getFilterOptions() {
  await ensureProductSchema()
  const [categories, brands, gstRates, vendors] = await Promise.all([
    query<any[]>(`SELECT name, parent FROM product_categories WHERE status = 'Active' ORDER BY parent IS NOT NULL, name`),
    query<any[]>(`SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL AND brand <> '' ORDER BY brand`),
    query<any[]>(`SELECT DISTINCT gst_rate FROM products ORDER BY gst_rate`),
    query<any[]>(`SELECT DISTINCT preferred_vendor_id AS id, preferred_vendor_name AS name FROM products WHERE preferred_vendor_id IS NOT NULL AND preferred_vendor_id <> ''`),
  ])
  return {
    categories: (categories as any[]).map((c) => ({ name: c.name, parent: c.parent })),
    brands: (brands as any[]).map((b) => b.brand),
    gstRates: (gstRates as any[]).map((g) => Number(g.gst_rate)),
    vendors: (vendors as any[]).filter((v) => v.id),
    productTypes: [...PRODUCT_TYPES],
    units: [...UNITS],
    statuses: [...STATUSES],
    stockStatuses: ["In Stock", "Low Stock", "Out of Stock"],
  }
}

/** Products at or below reorder level (Phases 23/61/62). */
export async function getReorderProducts() {
  await ensureProductSchema()
  return (await query<any[]>(
    `SELECT p.*, ${stockStatusExpr("p")} AS stock_status
       FROM products p
       WHERE p.track_inventory = 1 AND p.status = 'Active'
         AND ((p.current_stock <= 0)
           OR (p.reorder_level > 0 AND p.current_stock <= p.reorder_level)
           OR (p.min_stock > 0 AND p.current_stock <= p.min_stock))
       ORDER BY p.current_stock ASC`,
  )) as any[]
}

export class ProductError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message)
    this.name = "ProductError"
  }
}
