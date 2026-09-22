import { beforeEach, describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({ query: vi.fn(), tenant: vi.fn() }))
vi.mock("@/lib/db", () => ({ query: mock.query }))
vi.mock("@/lib/tenant-scope", () => ({ currentTenantId: mock.tenant }))

import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  ProductError,
} from "@/lib/shopkeeper-products"

const TENANT_A = 7
const TENANT_B = 99

const productRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: "Tea",
  sku: "T-1",
  category: "Beverages",
  description: null,
  price: "50.00",
  offer_price: null,
  currency: "INR",
  image_url: null,
  stock_status: "in_stock",
  stock_quantity: 10,
  status: "active",
  created_at: "2026-09-22 10:00:00",
  updated_at: "2026-09-22 10:00:00",
  ...over,
})

/** Every SQL string passed to query(), for asserting tenant predicates. */
const sqlCalls = () => mock.query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, " "))

beforeEach(() => {
  // mockReset, not clearAllMocks: the latter leaves unconsumed
  // mockResolvedValueOnce values queued, which then leak into the next test.
  mock.query.mockReset()
  mock.tenant.mockReset()
  mock.tenant.mockReturnValue(TENANT_A)
})

describe("Shopkeeper products — tenant isolation", () => {
  it("scopes every list query to the acting tenant", async () => {
    mock.query.mockResolvedValueOnce([productRow()]).mockResolvedValueOnce([{ total: 1 }])
    await listProducts()
    for (const sql of sqlCalls()) expect(sql).toContain("tenant_id = ?")
    expect(mock.query.mock.calls[0][1]).toContain(TENANT_A)
  })

  it("does not return another tenant's product by id", async () => {
    // The tenant predicate means a foreign id simply matches no row.
    mock.query.mockResolvedValueOnce([])
    expect(await getProduct(4242)).toBeNull()
    expect(sqlCalls()[0]).toContain("WHERE id = ? AND tenant_id = ?")
    expect(mock.query.mock.calls[0][1]).toEqual([4242, TENANT_A])
  })

  it("never writes a tenant id supplied by the caller", async () => {
    mock.query
      .mockResolvedValueOnce([]) // sku clash check
      .mockResolvedValueOnce({ insertId: 5 })
      .mockResolvedValueOnce([productRow({ id: 5 })])
    await createProduct({ name: "Sugar", price: 20, sku: "S-1", tenant_id: TENANT_B }, 1)
    const insert = mock.query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO shopkeeper_products"))!
    expect(insert[1][0]).toBe(TENANT_A)
    expect(insert[1]).not.toContain(TENANT_B)
  })

  it("cannot update another tenant's product", async () => {
    mock.query.mockResolvedValueOnce([]) // getProduct → not visible to this tenant
    await expect(updateProduct(4242, { name: "Hijacked" })).rejects.toMatchObject({ status: 404 })
  })

  it("reports deletion of an invisible product as not found", async () => {
    mock.query.mockResolvedValueOnce([])
    expect(await deleteProduct(4242)).toBe(false)
  })
})

describe("Shopkeeper products — validation", () => {
  it("requires a name", async () => {
    await expect(createProduct({ price: 10 }, 1)).rejects.toBeInstanceOf(ProductError)
    await expect(createProduct({ price: 10 }, 1)).rejects.toMatchObject({
      status: 422,
      fields: { name: expect.any(String) },
    })
  })

  it("rejects a negative price", async () => {
    await expect(createProduct({ name: "X", price: -1 }, 1)).rejects.toMatchObject({
      fields: { price: expect.any(String) },
    })
  })

  it("rejects an offer price above the price", async () => {
    await expect(createProduct({ name: "X", price: 10, offerPrice: 25 }, 1)).rejects.toMatchObject({
      fields: { offerPrice: expect.any(String) },
    })
  })

  it("rejects a non-integer stock quantity", async () => {
    await expect(createProduct({ name: "X", price: 10, stockQuantity: 2.5 }, 1)).rejects.toMatchObject({
      fields: { stockQuantity: expect.any(String) },
    })
  })

  it("rejects an unknown status", async () => {
    await expect(createProduct({ name: "X", price: 10, status: "deleted" }, 1)).rejects.toMatchObject({
      fields: { status: expect.any(String) },
    })
  })

  it("rejects a duplicate SKU within the tenant", async () => {
    mock.query.mockResolvedValueOnce([{ id: 3 }])
    await expect(createProduct({ name: "X", price: 10, sku: "T-1" }, 1)).rejects.toMatchObject({ status: 409 })
  })

  it("treats an invalid id as not found rather than querying", async () => {
    expect(await getProduct(0)).toBeNull()
    expect(await getProduct(-5)).toBeNull()
    expect(mock.query).not.toHaveBeenCalled()
  })

  it("returns numeric money rather than driver strings", async () => {
    mock.query.mockResolvedValueOnce([productRow({ price: "50.00", offer_price: "45.50" })])
    const product = await getProduct(1)
    expect(product?.price).toBe(50)
    expect(product?.offerPrice).toBe(45.5)
  })
})
