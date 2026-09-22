import "server-only"
import { query, withTransaction } from "@/lib/db"
import { currentTenantId } from "@/lib/tenant-scope"

/**
 * Shopkeeper orders — tenant-owned.
 *
 * The ERP `sales_invoices` / `operations_work_orders` tables carry no tenant_id
 * and model a different process, so the shop app gets its own order domain.
 * Line items copy the product name and unit price at order time, so later edits
 * to the catalogue never rewrite historical orders.
 */

export type OrderStatus = "new" | "processing" | "completed" | "cancelled"
export type PaymentStatus = "pending" | "paid" | "cod"
export type DeliveryMethod = "shop_pickup" | "home_delivery"

const ORDER_STATUS: OrderStatus[] = ["new", "processing", "completed", "cancelled"]
const PAYMENT_STATUS: PaymentStatus[] = ["pending", "paid", "cod"]
const DELIVERY: DeliveryMethod[] = ["shop_pickup", "home_delivery"]

export type OrderItem = {
  id: number
  productId: number | null
  productName: string
  sku: string | null
  quantity: number
  unitPrice: number
  lineTotal: number
}

export type ShopkeeperOrder = {
  id: number
  orderNumber: string
  contactId: number | null
  conversationId: number | null
  customerName: string | null
  customerPhone: string | null
  subtotal: number
  discount: number
  total: number
  currency: string
  status: OrderStatus
  paymentStatus: PaymentStatus
  deliveryMethod: DeliveryMethod
  deliveryAddress: string | null
  notes: string | null
  createdBy: number | null
  createdAt: string
  updatedAt: string
  items: OrderItem[]
}

export class OrderError extends Error {
  constructor(message: string, readonly status = 400, readonly fields?: Record<string, string>) {
    super(message)
    this.name = "OrderError"
  }
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function mapItem(row: any): OrderItem {
  return {
    id: Number(row.id),
    productId: row.product_id === null ? null : Number(row.product_id),
    productName: row.product_name,
    sku: row.sku,
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price),
    lineTotal: Number(row.line_total),
  }
}

function mapOrder(row: any, items: OrderItem[]): ShopkeeperOrder {
  return {
    id: Number(row.id),
    orderNumber: row.order_number,
    contactId: row.contact_id === null ? null : Number(row.contact_id),
    conversationId: row.conversation_id === null ? null : Number(row.conversation_id),
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    subtotal: Number(row.subtotal),
    discount: Number(row.discount),
    total: Number(row.total),
    currency: row.currency,
    status: row.status,
    paymentStatus: row.payment_status,
    deliveryMethod: row.delivery_method,
    deliveryAddress: row.delivery_address,
    notes: row.notes,
    createdBy: row.created_by === null ? null : Number(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items,
  }
}

/**
 * Per-tenant sequential order number. Derived from the tenant's own highest
 * number so two tenants never see each other's volume, and guarded by the
 * (tenant_id, order_number) unique key against a concurrent duplicate.
 */
async function nextOrderNumber(tenantId: number): Promise<string> {
  const rows = await query<any[]>(
    "SELECT order_number FROM shopkeeper_orders WHERE tenant_id = ? ORDER BY id DESC LIMIT 1",
    [tenantId],
  )
  const last = rows[0]?.order_number as string | undefined
  const n = last && /^ORD-(\d+)$/.test(last) ? Number(last.slice(4)) + 1 : 1
  return `ORD-${String(n).padStart(5, "0")}`
}

async function loadItems(tenantId: number, orderIds: number[]): Promise<Map<number, OrderItem[]>> {
  const byOrder = new Map<number, OrderItem[]>()
  if (!orderIds.length) return byOrder
  const placeholders = orderIds.map(() => "?").join(",")
  const rows = await query<any[]>(
    `SELECT * FROM shopkeeper_order_items WHERE tenant_id = ? AND order_id IN (${placeholders}) ORDER BY id`,
    [tenantId, ...orderIds],
  )
  for (const row of rows) {
    const key = Number(row.order_id)
    const list = byOrder.get(key) ?? []
    list.push(mapItem(row))
    byOrder.set(key, list)
  }
  return byOrder
}

export type ListOrdersOptions = {
  status?: string
  paymentStatus?: string
  contactId?: number
  search?: string
  limit?: number
  offset?: number
}

export async function listOrders(options: ListOrdersOptions = {}) {
  const tenantId = currentTenantId()
  const where: string[] = ["tenant_id = ?"]
  const args: unknown[] = [tenantId]

  if (options.status && ORDER_STATUS.includes(options.status as OrderStatus)) {
    where.push("status = ?")
    args.push(options.status)
  }
  if (options.paymentStatus && PAYMENT_STATUS.includes(options.paymentStatus as PaymentStatus)) {
    where.push("payment_status = ?")
    args.push(options.paymentStatus)
  }
  if (Number.isInteger(options.contactId)) {
    where.push("contact_id = ?")
    args.push(options.contactId)
  }
  const search = text(options.search, 100)
  if (search) {
    where.push("(order_number LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)")
    const like = `%${search}%`
    args.push(like, like, like)
  }

  const limit = Math.max(1, Math.min(200, Number(options.limit) || 50))
  const offset = Math.max(0, Number(options.offset) || 0)
  const clause = where.join(" AND ")

  const rows = await query<any[]>(
    `SELECT * FROM shopkeeper_orders WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  )
  const [count] = await query<any[]>(`SELECT COUNT(*) AS total FROM shopkeeper_orders WHERE ${clause}`, args)
  const items = await loadItems(tenantId, rows.map((r) => Number(r.id)))

  return {
    orders: rows.map((r) => mapOrder(r, items.get(Number(r.id)) ?? [])),
    pagination: { limit, offset, total: Number(count?.total ?? 0) },
  }
}

export async function getOrder(id: number): Promise<ShopkeeperOrder | null> {
  if (!Number.isInteger(id) || id < 1) return null
  const tenantId = currentTenantId()
  const rows = await query<any[]>(
    "SELECT * FROM shopkeeper_orders WHERE id = ? AND tenant_id = ? LIMIT 1",
    [id, tenantId],
  )
  if (!rows[0]) return null
  const items = await loadItems(tenantId, [id])
  return mapOrder(rows[0], items.get(id) ?? [])
}

type IncomingItem = { productId?: unknown; productName?: unknown; quantity?: unknown; unitPrice?: unknown; sku?: unknown }

/**
 * Resolves each requested line against the tenant's own catalogue. A productId
 * belonging to another tenant simply does not resolve, so a guessed id cannot
 * pull a foreign product name or price into this tenant's order.
 */
async function resolveItems(tenantId: number, raw: unknown): Promise<{ items: Omit<OrderItem, "id">[]; subtotal: number }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new OrderError("An order needs at least one item.", 422, { items: "At least one item is required." })
  }
  if (raw.length > 200) throw new OrderError("Too many items in one order.", 422, { items: "Maximum 200 items." })

  const requested = raw as IncomingItem[]
  const ids = [...new Set(requested.map((i) => Number(i.productId)).filter((n) => Number.isInteger(n) && n > 0))]

  const catalogue = new Map<number, any>()
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",")
    const rows = await query<any[]>(
      `SELECT id, name, sku, price, offer_price FROM shopkeeper_products WHERE tenant_id = ? AND id IN (${placeholders})`,
      [tenantId, ...ids],
    )
    for (const row of rows) catalogue.set(Number(row.id), row)
  }

  const items: Omit<OrderItem, "id">[] = []
  let subtotal = 0

  requested.forEach((item, index) => {
    const quantity = Number(item.quantity ?? 1)
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new OrderError("Invalid item quantity.", 422, { [`items.${index}.quantity`]: "Must be a whole number of 1 or more." })
    }

    const productId = Number(item.productId)
    const product = Number.isInteger(productId) ? catalogue.get(productId) : undefined
    if (item.productId !== undefined && item.productId !== null && !product) {
      throw new OrderError("Product not found in this shop.", 422, { [`items.${index}.productId`]: "Unknown product." })
    }

    const name = product ? product.name : text(item.productName, 190)
    if (!name) {
      throw new OrderError("Each item needs a product or a name.", 422, { [`items.${index}.productName`]: "Required." })
    }

    // Price precedence: explicit override, else the product's offer price, else
    // its list price. The override lets a shopkeeper honour a negotiated price.
    let unitPrice: number
    if (item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== "") {
      const n = Number(item.unitPrice)
      if (!Number.isFinite(n) || n < 0) {
        throw new OrderError("Invalid item price.", 422, { [`items.${index}.unitPrice`]: "Must be 0 or more." })
      }
      unitPrice = round(n)
    } else if (product) {
      unitPrice = Number(product.offer_price ?? product.price)
    } else {
      throw new OrderError("Each item needs a price.", 422, { [`items.${index}.unitPrice`]: "Required." })
    }

    const lineTotal = round(unitPrice * quantity)
    subtotal = round(subtotal + lineTotal)
    items.push({
      productId: product ? Number(product.id) : null,
      productName: name,
      sku: product ? product.sku : text(item.sku, 64),
      quantity,
      unitPrice,
      lineTotal,
    })
  })

  return { items, subtotal }
}

/**
 * Resolves the customer from a conversation the tenant owns (Phase 4). The
 * conversation is looked up WITH the tenant predicate, so another tenant's
 * conversation id resolves to nothing rather than leaking its contact.
 */
async function resolveConversation(tenantId: number, conversationId: number) {
  const rows = await query<any[]>(
    `SELECT c.id, c.contact_id, ct.profile_name AS contact_name, ct.phone_number AS contact_phone
       FROM marketing_whatsapp_conversations c
       LEFT JOIN marketing_whatsapp_contacts ct
         ON ct.id = c.contact_id AND ct.tenant_id = c.tenant_id
      WHERE c.id = ? AND c.tenant_id = ? LIMIT 1`,
    [conversationId, tenantId],
  )
  if (!rows[0]) {
    throw new OrderError("Conversation not found.", 404, { conversationId: "Unknown conversation." })
  }
  return rows[0]
}

export type CreateOrderInput = Record<string, unknown>

export async function createOrder(input: CreateOrderInput, userId: number): Promise<ShopkeeperOrder> {
  const tenantId = currentTenantId()

  let contactId: number | null = null
  let conversationId: number | null = null
  let customerName = text(input.customerName, 190)
  let customerPhone = text(input.customerPhone, 40)

  const rawConversation = input.conversationId
  if (rawConversation !== undefined && rawConversation !== null && rawConversation !== "") {
    const n = Number(rawConversation)
    if (!Number.isInteger(n) || n < 1) {
      throw new OrderError("Invalid conversation.", 422, { conversationId: "Must be a valid id." })
    }
    const conversation = await resolveConversation(tenantId, n)
    conversationId = Number(conversation.id)
    contactId = conversation.contact_id === null ? null : Number(conversation.contact_id)
    customerName = customerName ?? conversation.contact_name ?? null
    customerPhone = customerPhone ?? conversation.contact_phone ?? null
  }

  const rawContact = input.contactId
  if (rawContact !== undefined && rawContact !== null && rawContact !== "") {
    const n = Number(rawContact)
    if (!Number.isInteger(n) || n < 1) {
      throw new OrderError("Invalid customer.", 422, { contactId: "Must be a valid id." })
    }
    const rows = await query<any[]>(
      "SELECT id, profile_name, phone_number FROM marketing_whatsapp_contacts WHERE id = ? AND tenant_id = ? LIMIT 1",
      [n, tenantId],
    )
    if (!rows[0]) throw new OrderError("Customer not found.", 404, { contactId: "Unknown customer." })
    contactId = Number(rows[0].id)
    customerName = customerName ?? rows[0].profile_name ?? null
    customerPhone = customerPhone ?? rows[0].phone_number ?? null
  }

  const { items, subtotal } = await resolveItems(tenantId, input.items)

  const discountRaw = input.discount
  let discount = 0
  if (discountRaw !== undefined && discountRaw !== null && discountRaw !== "") {
    const n = Number(discountRaw)
    if (!Number.isFinite(n) || n < 0) throw new OrderError("Invalid discount.", 422, { discount: "Must be 0 or more." })
    if (n > subtotal) throw new OrderError("Discount is larger than the order.", 422, { discount: "Cannot exceed the subtotal." })
    discount = round(n)
  }
  const total = round(subtotal - discount)

  const status = ORDER_STATUS.includes(String(input.status) as OrderStatus) ? String(input.status) : "new"
  const paymentStatus = PAYMENT_STATUS.includes(String(input.paymentStatus) as PaymentStatus)
    ? String(input.paymentStatus)
    : "pending"
  const deliveryMethod = DELIVERY.includes(String(input.deliveryMethod) as DeliveryMethod)
    ? String(input.deliveryMethod)
    : "shop_pickup"

  const orderId = await withTransaction(async (tx: any) => {
    const orderNumber = await nextOrderNumber(tenantId)
    const result = await tx.query(
      `INSERT INTO shopkeeper_orders
         (tenant_id, order_number, contact_id, conversation_id, customer_name, customer_phone,
          subtotal, discount, total, currency, status, payment_status, delivery_method,
          delivery_address, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        tenantId,
        orderNumber,
        contactId,
        conversationId,
        customerName,
        customerPhone,
        subtotal,
        discount,
        total,
        text(input.currency, 8) || "INR",
        status,
        paymentStatus,
        deliveryMethod,
        text(input.deliveryAddress, 500),
        text(input.notes, 2000),
        userId,
      ],
    )
    const id = Number((Array.isArray(result) ? result[0] : result).insertId)
    for (const item of items) {
      await tx.query(
        `INSERT INTO shopkeeper_order_items
           (tenant_id, order_id, product_id, product_name, sku, quantity, unit_price, line_total)
         VALUES (?,?,?,?,?,?,?,?)`,
        [tenantId, id, item.productId, item.productName, item.sku, item.quantity, item.unitPrice, item.lineTotal],
      )
      // Draw down tracked stock inside the same transaction. GREATEST(...,0)
      // keeps the count from going negative when a shopkeeper sells from the
      // counter faster than they update the app; free-text lines and untracked
      // products (stock_quantity IS NULL) are skipped.
      if (item.productId !== null) {
        await tx.query(
          `UPDATE shopkeeper_products
              SET stock_quantity = GREATEST(CAST(stock_quantity AS SIGNED) - ?, 0)
            WHERE id = ? AND tenant_id = ? AND stock_quantity IS NOT NULL`,
          [item.quantity, item.productId, tenantId],
        )
      }
    }
    return id
  })

  const created = await getOrder(orderId)
  if (!created) throw new OrderError("The order could not be read back after creation.", 500)
  return created
}

export async function updateOrder(id: number, input: Record<string, unknown>): Promise<ShopkeeperOrder> {
  const tenantId = currentTenantId()
  const existing = await getOrder(id)
  if (!existing) throw new OrderError("Order not found.", 404)

  const sets: string[] = []
  const args: unknown[] = []
  const fields: Record<string, string> = {}

  if (input.status !== undefined) {
    if (!ORDER_STATUS.includes(String(input.status) as OrderStatus)) fields.status = `Must be one of: ${ORDER_STATUS.join(", ")}.`
    else { sets.push("status = ?"); args.push(input.status) }
  }
  if (input.paymentStatus !== undefined) {
    if (!PAYMENT_STATUS.includes(String(input.paymentStatus) as PaymentStatus)) fields.paymentStatus = `Must be one of: ${PAYMENT_STATUS.join(", ")}.`
    else { sets.push("payment_status = ?"); args.push(input.paymentStatus) }
  }
  if (input.deliveryMethod !== undefined) {
    if (!DELIVERY.includes(String(input.deliveryMethod) as DeliveryMethod)) fields.deliveryMethod = `Must be one of: ${DELIVERY.join(", ")}.`
    else { sets.push("delivery_method = ?"); args.push(input.deliveryMethod) }
  }
  if (input.deliveryAddress !== undefined) { sets.push("delivery_address = ?"); args.push(text(input.deliveryAddress, 500)) }
  if (input.notes !== undefined) { sets.push("notes = ?"); args.push(text(input.notes, 2000)) }
  if (input.customerName !== undefined) { sets.push("customer_name = ?"); args.push(text(input.customerName, 190)) }
  if (input.customerPhone !== undefined) { sets.push("customer_phone = ?"); args.push(text(input.customerPhone, 40)) }

  if (input.discount !== undefined) {
    const n = Number(input.discount)
    if (!Number.isFinite(n) || n < 0) fields.discount = "Must be 0 or more."
    else if (n > existing.subtotal) fields.discount = "Cannot exceed the subtotal."
    else {
      sets.push("discount = ?", "total = ?")
      args.push(round(n), round(existing.subtotal - n))
    }
  }

  if (Object.keys(fields).length) throw new OrderError("The order could not be updated.", 422, fields)
  if (sets.length) {
    await query(`UPDATE shopkeeper_orders SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`, [...args, id, tenantId])
  }

  // Cancelling returns the reserved stock. Guarded on the previous status so a
  // repeated cancel cannot credit the same units twice.
  if (input.status === "cancelled" && existing.status !== "cancelled") {
    for (const item of existing.items) {
      if (item.productId === null) continue
      await query(
        `UPDATE shopkeeper_products
            SET stock_quantity = stock_quantity + ?
          WHERE id = ? AND tenant_id = ? AND stock_quantity IS NOT NULL`,
        [item.quantity, item.productId, tenantId],
      )
    }
  }
  return (await getOrder(id))!
}
