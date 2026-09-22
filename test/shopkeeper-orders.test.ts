import { beforeEach, describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({ query: vi.fn(), tenant: vi.fn(), tx: vi.fn() }))
vi.mock("@/lib/db", () => ({
  query: mock.query,
  // Run the callback against a fake connection so the transaction body is
  // exercised without a real database.
  withTransaction: (fn: any) => fn({ query: mock.tx }),
}))
vi.mock("@/lib/tenant-scope", () => ({ currentTenantId: mock.tenant }))

import { listOrders, getOrder, createOrder, updateOrder, OrderError } from "@/lib/shopkeeper-orders"

const TENANT_A = 7
const TENANT_B = 99

const orderRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  order_number: "ORD-00001",
  contact_id: null,
  conversation_id: null,
  customer_name: "Asha",
  customer_phone: "919000000000",
  subtotal: "100.00",
  discount: "0.00",
  total: "100.00",
  currency: "INR",
  status: "new",
  payment_status: "pending",
  delivery_method: "shop_pickup",
  delivery_address: null,
  notes: null,
  created_by: 1,
  created_at: "2026-09-22 10:00:00",
  updated_at: "2026-09-22 10:00:00",
  ...over,
})

const sqlCalls = () => mock.query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, " "))

beforeEach(() => {
  // mockReset, not clearAllMocks: the latter leaves unconsumed
  // mockResolvedValueOnce values queued, which then leak into the next test.
  mock.query.mockReset()
  mock.tx.mockReset()
  mock.tenant.mockReset()
  mock.tenant.mockReturnValue(TENANT_A)
})

describe("Shopkeeper orders — tenant isolation", () => {
  it("scopes list and count queries to the acting tenant", async () => {
    mock.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }])
    await listOrders()
    for (const sql of sqlCalls()) expect(sql).toContain("tenant_id = ?")
  })

  it("does not return another tenant's order", async () => {
    mock.query.mockResolvedValueOnce([])
    expect(await getOrder(4242)).toBeNull()
    expect(mock.query.mock.calls[0][1]).toEqual([4242, TENANT_A])
  })

  it("cannot update another tenant's order", async () => {
    mock.query.mockResolvedValueOnce([])
    await expect(updateOrder(4242, { status: "completed" })).rejects.toMatchObject({ status: 404 })
  })

  it("rejects a product id that belongs to another tenant", async () => {
    // The catalogue lookup is tenant-filtered, so a foreign product resolves to
    // nothing and the line is refused rather than silently priced.
    mock.query.mockResolvedValueOnce([])
    await expect(
      createOrder({ items: [{ productId: 4242, quantity: 1 }] }, 1),
    ).rejects.toMatchObject({ status: 422 })
    expect(sqlCalls()[0]).toContain("tenant_id = ?")
  })

  it("rejects a contact that belongs to another tenant", async () => {
    mock.query.mockResolvedValueOnce([]) // contact lookup, tenant-filtered
    await expect(
      createOrder({ contactId: 4242, items: [{ productName: "X", unitPrice: 5 }] }, 1),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe("Shopkeeper orders — creation from WhatsApp", () => {
  it("resolves the customer from a conversation the tenant owns", async () => {
    mock.query
      .mockResolvedValueOnce([{ id: 12, contact_id: 3, contact_name: "Asha", contact_phone: "919000000000" }])
      .mockResolvedValueOnce([{ id: 50, name: "Tea", sku: "T-1", price: "50.00", offer_price: null }])
      .mockResolvedValueOnce([]) // nextOrderNumber
      .mockResolvedValueOnce([orderRow({ conversation_id: 12, contact_id: 3 })])
      .mockResolvedValueOnce([])
    mock.tx.mockResolvedValueOnce([{ insertId: 1 }]).mockResolvedValue([{}])

    const order = await createOrder({ conversationId: 12, items: [{ productId: 50, quantity: 2 }] }, 1)
    expect(order.conversationId).toBe(12)
    expect(order.contactId).toBe(3)

    const lookup = sqlCalls()[0]
    expect(lookup).toContain("c.tenant_id = ?")
  })

  it("rejects a conversation belonging to another tenant", async () => {
    mock.query.mockResolvedValueOnce([]) // tenant-filtered lookup finds nothing
    await expect(
      createOrder({ conversationId: 4242, items: [{ productName: "X", unitPrice: 5 }] }, 1),
    ).rejects.toMatchObject({ status: 404, fields: { conversationId: expect.any(String) } })
    expect(mock.query.mock.calls[0][1]).toEqual([4242, TENANT_A])
  })
})

describe("Shopkeeper orders — items and totals", () => {
  it("prices from the catalogue and computes line and order totals", async () => {
    mock.query
      .mockResolvedValueOnce([{ id: 50, name: "Tea", sku: "T-1", price: "50.00", offer_price: "45.00" }])
      .mockResolvedValueOnce([]) // nextOrderNumber
      .mockResolvedValueOnce([orderRow({ subtotal: "90.00", total: "90.00" })])
      .mockResolvedValueOnce([
        { id: 1, order_id: 1, product_id: 50, product_name: "Tea", sku: "T-1", quantity: 2, unit_price: "45.00", line_total: "90.00" },
      ])
    mock.tx.mockResolvedValueOnce([{ insertId: 1 }]).mockResolvedValue([{}])

    const order = await createOrder({ items: [{ productId: 50, quantity: 2 }] }, 1)
    // Offer price wins over list price.
    expect(order.items[0].unitPrice).toBe(45)
    expect(order.items[0].lineTotal).toBe(90)

    const insert = mock.tx.mock.calls.find((c) => String(c[0]).includes("INSERT INTO shopkeeper_orders"))!
    expect(insert[1][0]).toBe(TENANT_A)
    expect(insert[1]).toContain(90) // subtotal
  })

  it("requires at least one item", async () => {
    await expect(createOrder({ items: [] }, 1)).rejects.toMatchObject({ status: 422 })
    await expect(createOrder({}, 1)).rejects.toBeInstanceOf(OrderError)
  })

  it("rejects a zero or fractional quantity", async () => {
    await expect(createOrder({ items: [{ productName: "X", unitPrice: 5, quantity: 0 }] }, 1)).rejects.toMatchObject({ status: 422 })
    await expect(createOrder({ items: [{ productName: "X", unitPrice: 5, quantity: 1.5 }] }, 1)).rejects.toMatchObject({ status: 422 })
  })

  it("rejects a discount larger than the subtotal", async () => {
    mock.query.mockResolvedValueOnce([])
    await expect(
      createOrder({ discount: 500, items: [{ productName: "X", unitPrice: 5, quantity: 1 }] }, 1),
    ).rejects.toMatchObject({ fields: { discount: expect.any(String) } })
  })

  it("requires a price for a free-text item", async () => {
    mock.query.mockResolvedValueOnce([])
    await expect(createOrder({ items: [{ productName: "Custom" }] }, 1)).rejects.toMatchObject({ status: 422 })
  })
})

describe("Shopkeeper orders — stock movement", () => {
  it("draws down tracked stock for catalogue lines, scoped to the tenant", async () => {
    mock.query
      .mockResolvedValueOnce([{ id: 50, name: "Tea", sku: "T-1", price: "50.00", offer_price: null }])
      .mockResolvedValueOnce([]) // nextOrderNumber
      .mockResolvedValueOnce([orderRow()])
      .mockResolvedValueOnce([])
    mock.tx.mockResolvedValueOnce([{ insertId: 1 }]).mockResolvedValue([{}])

    await createOrder({ items: [{ productId: 50, quantity: 3 }] }, 1)
    const stock = mock.tx.mock.calls.find((c) => String(c[0]).includes("stock_quantity ="))!
    expect(String(stock[0])).toContain("GREATEST")
    expect(String(stock[0])).toContain("tenant_id = ?")
    expect(stock[1]).toEqual([3, 50, TENANT_A])
  })

  it("does not touch stock for a free-text line", async () => {
    // With no productId in the payload there is no catalogue lookup at all,
    // so the first query is nextOrderNumber.
    mock.query
      .mockResolvedValueOnce([]) // nextOrderNumber
      .mockResolvedValueOnce([orderRow()])
      .mockResolvedValueOnce([])
    mock.tx.mockResolvedValueOnce([{ insertId: 1 }]).mockResolvedValue([{}])

    await createOrder({ items: [{ productName: "Custom cake", unitPrice: 500 }] }, 1)
    expect(mock.tx.mock.calls.some((c) => String(c[0]).includes("stock_quantity ="))).toBe(false)
  })

  it("returns stock when an order is cancelled", async () => {
    const withItem = { ...orderRow(), status: "new" }
    mock.query
      .mockResolvedValueOnce([withItem])
      .mockResolvedValueOnce([
        { id: 1, order_id: 1, product_id: 50, product_name: "Tea", sku: "T-1", quantity: 2, unit_price: "45.00", line_total: "90.00" },
      ])
      .mockResolvedValueOnce({}) // status update
      .mockResolvedValueOnce({}) // stock restore
      .mockResolvedValueOnce([{ ...withItem, status: "cancelled" }])
      .mockResolvedValueOnce([])
    await updateOrder(1, { status: "cancelled" })
    const restore = mock.query.mock.calls.find((c) => String(c[0]).includes("stock_quantity + ?"))!
    expect(restore[1]).toEqual([2, 50, TENANT_A])
  })

  it("does not credit stock twice when cancelling an already-cancelled order", async () => {
    mock.query
      .mockResolvedValueOnce([orderRow({ status: "cancelled" })])
      .mockResolvedValueOnce([
        { id: 1, order_id: 1, product_id: 50, product_name: "Tea", sku: "T-1", quantity: 2, unit_price: "45.00", line_total: "90.00" },
      ])
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce([orderRow({ status: "cancelled" })])
      .mockResolvedValueOnce([])
    await updateOrder(1, { status: "cancelled" })
    expect(mock.query.mock.calls.some((c) => String(c[0]).includes("stock_quantity + ?"))).toBe(false)
  })
})

describe("Shopkeeper orders — status updates", () => {
  it("rejects a status outside the supported set", async () => {
    mock.query.mockResolvedValueOnce([orderRow()]).mockResolvedValueOnce([])
    await expect(updateOrder(1, { status: "refunded" })).rejects.toMatchObject({
      status: 422,
      fields: { status: expect.any(String) },
    })
  })

  it("accepts the four mobile statuses and recomputes the total on discount", async () => {
    mock.query
      .mockResolvedValueOnce([orderRow()])
      .mockResolvedValueOnce([]) // items
      .mockResolvedValueOnce({}) // update
      .mockResolvedValueOnce([orderRow({ status: "completed", discount: "10.00", total: "90.00" })])
      .mockResolvedValueOnce([])
    const order = await updateOrder(1, { status: "completed", discount: 10 })
    expect(order.status).toBe("completed")
    const update = mock.query.mock.calls.find((c) => String(c[0]).startsWith("UPDATE shopkeeper_orders"))!
    expect(String(update[0])).toContain("tenant_id = ?")
    expect(update[1]).toContain(90) // total recomputed from subtotal - discount
  })
})
