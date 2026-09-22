import { beforeEach, describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({
  query: vi.fn(),
  tenant: vi.fn(),
  entitlements: vi.fn(),
  auth: vi.fn(),
  actor: vi.fn(),
}))
vi.mock("@/lib/db", () => ({ query: mock.query }))
vi.mock("@/lib/tenant-scope", () => ({
  currentTenantId: mock.tenant,
  runForTenant: (_: unknown, fn: any) => fn(),
}))
vi.mock("@/lib/platform/entitlement-guard", () => ({ getTenantEntitlements: mock.entitlements }))
vi.mock("@/lib/mobile-auth", () => ({ authenticateMobileRequest: mock.auth, auditMobileAction: vi.fn() }))
vi.mock("@/lib/actor-context", () => ({ setCurrentActor: mock.actor }))

import {
  listShopkeeperContacts,
  getShopkeeperContact,
  createShopkeeperContact,
  updateShopkeeperContact,
  archiveShopkeeperContact,
  ContactError,
} from "@/lib/shopkeeper-contacts"
import { getShopkeeperDashboard } from "@/lib/shopkeeper-dashboard"
import { withMobileAuth } from "@/lib/mobile-api"

const TENANT_A = 7
const TENANT_B = 99

const contactRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  phone_number: "919000000000",
  profile_name: "Asha",
  email: null,
  notes: null,
  tags: '["vip"]',
  city: null,
  state: null,
  country: null,
  lead_id: null,
  archived_at: null,
  last_interaction_at: null,
  created_at: "2026-09-22 10:00:00",
  ...over,
})

const sqlCalls = () => mock.query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, " "))

beforeEach(() => {
  mock.query.mockReset()
  mock.tenant.mockReset()
  mock.entitlements.mockReset()
  mock.auth.mockReset()
  mock.tenant.mockReturnValue(TENANT_A)
})

describe("Shopkeeper contacts — isolation and CRUD", () => {
  it("scopes the list to the tenant and hides archived customers by default", async () => {
    mock.query.mockResolvedValueOnce([contactRow()]).mockResolvedValueOnce([{ total: 1 }])
    await listShopkeeperContacts()
    expect(sqlCalls()[0]).toContain("tenant_id = ?")
    expect(sqlCalls()[0]).toContain("archived_at IS NULL")
  })

  it("does not return another tenant's customer", async () => {
    mock.query.mockResolvedValueOnce([])
    expect(await getShopkeeperContact(4242)).toBeNull()
    expect(mock.query.mock.calls[0][1]).toEqual([4242, TENANT_A])
  })

  it("never writes a caller-supplied tenant id", async () => {
    mock.query
      .mockResolvedValueOnce([]) // duplicate check
      .mockResolvedValueOnce({ insertId: 2 })
      .mockResolvedValueOnce([contactRow({ id: 2 })])
    await createShopkeeperContact({ phone: "+91 90000 00001", name: "Ravi", tenant_id: TENANT_B })
    const insert = mock.query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO"))!
    expect(insert[1][0]).toBe(TENANT_A)
    expect(insert[1]).not.toContain(TENANT_B)
  })

  it("normalizes the phone number before storing it", async () => {
    mock.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ insertId: 2 })
      .mockResolvedValueOnce([contactRow({ id: 2 })])
    await createShopkeeperContact({ phone: "+91 90000 00001" })
    const insert = mock.query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO"))!
    expect(insert[1][1]).toBe("+919000000001")
  })

  it("rejects a missing or too-short phone number", async () => {
    await expect(createShopkeeperContact({})).rejects.toBeInstanceOf(ContactError)
    await expect(createShopkeeperContact({ phone: "12" })).rejects.toMatchObject({
      status: 422,
      fields: { phone: expect.any(String) },
    })
  })

  it("rejects a malformed email", async () => {
    await expect(createShopkeeperContact({ phone: "919000000000", email: "not-an-email" })).rejects.toMatchObject({
      fields: { email: expect.any(String) },
    })
  })

  it("restores an archived customer instead of erroring on re-add", async () => {
    mock.query
      .mockResolvedValueOnce([contactRow({ id: 5, archived_at: "2026-09-01 00:00:00" })])
      .mockResolvedValueOnce({}) // un-archive
      .mockResolvedValueOnce([contactRow({ id: 5 })])
    const contact = await createShopkeeperContact({ phone: "919000000000" })
    expect(contact.id).toBe(5)
    expect(sqlCalls().some((s) => s.includes("archived_at = NULL"))).toBe(true)
  })

  it("rejects a duplicate active phone number", async () => {
    mock.query.mockResolvedValueOnce([contactRow({ id: 5 })])
    await expect(createShopkeeperContact({ phone: "919000000000" })).rejects.toMatchObject({ status: 409 })
  })

  it("cannot update another tenant's customer", async () => {
    mock.query.mockResolvedValueOnce([])
    await expect(updateShopkeeperContact(4242, { name: "Hijacked" })).rejects.toMatchObject({ status: 404 })
  })

  it("archives rather than deletes, preserving order history", async () => {
    mock.query.mockResolvedValueOnce([contactRow()]).mockResolvedValueOnce({})
    expect(await archiveShopkeeperContact(1)).toBe(true)
    const update = mock.query.mock.calls.find((c) => String(c[0]).startsWith("UPDATE"))!
    expect(String(update[0])).toContain("archived_at = CURRENT_TIMESTAMP")
    expect(sqlCalls().some((s) => s.startsWith("DELETE"))).toBe(false)
  })

  it("parses tags stored as JSON", async () => {
    mock.query.mockResolvedValueOnce([contactRow({ tags: '["vip","wholesale"]' })])
    const contact = await getShopkeeperContact(1)
    expect(contact?.tags).toEqual(["vip", "wholesale"])
  })
})

describe("Shopkeeper dashboard", () => {
  it("scopes every metric to the acting tenant", async () => {
    mock.query.mockResolvedValue([{ value: 0 }])
    await getShopkeeperDashboard()
    for (const call of mock.query.mock.calls) {
      expect(String(call[0])).toContain("tenant_id = ?")
      expect(call[1]).toContain(TENANT_A)
    }
  })

  it("returns zeros instead of failing when a module table is absent", async () => {
    mock.query.mockRejectedValue(new Error("Table 'shopkeeper_orders' doesn't exist"))
    const dashboard = await getShopkeeperDashboard()
    expect(dashboard.todayOrders).toBe(0)
    expect(dashboard.todaySales).toBe(0)
    expect(dashboard.recentOrders).toEqual([])
    expect(dashboard.whatsapp.connected).toBe(false)
  })

  it("excludes cancelled orders from today's sales", async () => {
    mock.query.mockResolvedValue([{ value: 0 }])
    await getShopkeeperDashboard()
    const sales = mock.query.mock.calls.find((c) => String(c[0]).includes("SUM(total)"))!
    expect(String(sales[0])).toContain("status <> 'cancelled'")
  })
})

describe("Mobile entitlement enforcement", () => {
  const principal = {
    userId: 10,
    tenantId: TENANT_A,
    name: "Shop Owner",
    email: "owner@example.test",
    role: "admin" as const,
    tenantRole: "tenant_owner",
    sessionId: "s1",
  }

  it("returns 403 when the plan lacks the products feature", async () => {
    mock.auth.mockResolvedValue(principal)
    mock.entitlements.mockResolvedValue({ feature_flags: ["shopkeeper.mobile_app"] })
    const result: any = await withMobileAuth(new Request("https://example.test/products"), async () => "ran", "products")
    expect(result.status).toBe(403)
  })

  it("returns 401 for an expired or invalid token before any feature check", async () => {
    mock.auth.mockResolvedValue(null)
    const result: any = await withMobileAuth(new Request("https://example.test/orders"), async () => "ran", "orders")
    expect(result.status).toBe(401)
    expect(mock.entitlements).not.toHaveBeenCalled()
  })

  it("allows the handler when both base access and the feature are granted", async () => {
    mock.auth.mockResolvedValue(principal)
    mock.entitlements.mockResolvedValue({ feature_flags: ["shopkeeper.mobile_app", "shopkeeper.orders"] })
    const result = await withMobileAuth(new Request("https://example.test/orders"), async () => "ran", "orders")
    expect(result).toBe("ran")
  })

  it("ignores a tenant id supplied in the query string", async () => {
    mock.auth.mockResolvedValue(principal)
    mock.entitlements.mockResolvedValue({ feature_flags: ["shopkeeper.mobile_app", "shopkeeper.products"] })
    let seen = 0
    await withMobileAuth(
      new Request(`https://example.test/products?tenant_id=${TENANT_B}`),
      async (p) => { seen = p.tenantId; return "ok" },
      "products",
    )
    expect(seen).toBe(TENANT_A)
    expect(mock.entitlements).toHaveBeenCalledWith(TENANT_A)
    expect(mock.entitlements).not.toHaveBeenCalledWith(TENANT_B)
  })
})
