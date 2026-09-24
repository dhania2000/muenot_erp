import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { SignJWT } from "jose"

/**
 * SPEC 119 — Vendor Portal · Phase 4: tenant / VENDOR isolation + authorization.
 * ---------------------------------------------------------------------------
 * The vendor portal isolates data on TWO axes that must BOTH hold on every
 * access:
 *
 *   1. tenant_id  — enforced globally by the data-layer guard.
 *   2. vendor_id  — enforced by the vendor-portal store; this is what stops one
 *      vendor from reading another vendor's rows INSIDE the same tenant.
 *
 * Both `tenantId` and `vendorId` must originate from the verified vendor-portal
 * session, never from portal-user input. These tests mock the DB layer to
 * capture the exact SQL + params each helper emits and prove that:
 *   - every read/write is constrained by BOTH tenant_id AND vendor_id,
 *   - vendor-submitted invoices are stamped from the session, not input,
 *   - vendor-portal session tokens are domain-separated from internal and
 *     client-portal tokens,
 *   - resource access is fail-closed.
 */

// Capture every statement the helpers would run instead of hitting MySQL.
const calls: { sql: string; params: any[] }[] = []
let results: any[] = []

vi.mock("@/lib/db", () => ({
  query: vi.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params })
    return results.length ? results.shift() : []
  }),
}))

// The runtime schema self-heal is irrelevant to isolation; keep it out of the
// captured statements so assertions read cleanly.
vi.mock("@/lib/vendor-portal/schema", () => ({
  ensureVendorPortalSchema: vi.fn(async () => {}),
}))

// Password verification is controlled per-test.
const passwordMock = vi.hoisted(() => ({ verify: vi.fn(async () => true) }))
vi.mock("@/lib/password", () => ({
  hashPassword: vi.fn(async (p: string) => `hash:${p}`),
  verifyPassword: passwordMock.verify,
}))

// getVendorPortalSession pushes the tenant into request context; stub it out.
vi.mock("@/lib/tenant-context", () => ({
  setCurrentTenant: vi.fn(),
}))

import {
  VENDOR_PORTAL_RESOURCES,
  isVendorPortalResource,
  isVendorPortalItemResource,
} from "@/lib/vendor-portal/config"
import { resolveGrantedResources } from "@/lib/vendor-portal/access"
import {
  createVendorPortalSessionToken,
  verifyVendorPortalSessionToken,
  type VendorPortalSessionPayload,
} from "@/lib/vendor-portal/auth"
import {
  authenticateVendorUser,
  countItemsByResource,
  createMessage,
  listItems,
  listMessages,
  submitVendorInvoice,
} from "@/lib/vendor-portal/store"

const TENANT = 7
const VENDOR = 42

/** Params that carry both the tenant AND the vendor scope. */
function scopedByTenantAndVendor(params: any[]): boolean {
  return params.includes(TENANT) && params.includes(VENDOR)
}

beforeAll(() => {
  process.env.SESSION_SECRET = "test-vendor-portal-secret"
})

beforeEach(() => {
  calls.length = 0
  results = []
  passwordMock.verify.mockResolvedValue(true)
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// SPEC coverage: every resource the spec lists is representable.
// ---------------------------------------------------------------------------
describe("resource coverage (SPEC 119)", () => {
  it("exposes exactly the six permitted resources", () => {
    expect([...VENDOR_PORTAL_RESOURCES].sort()).toEqual(
      ["compliance", "documents", "invoices", "messages", "payments", "purchase-orders"].sort(),
    )
  })

  it("recognizes valid resources and rejects unknown ones", () => {
    expect(isVendorPortalResource("invoices")).toBe(true)
    expect(isVendorPortalResource("payroll")).toBe(false)
    // Messages are interactive, not read-only shared "items".
    expect(isVendorPortalItemResource("purchase-orders")).toBe(true)
    expect(isVendorPortalItemResource("messages")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Access control is fail-closed.
// ---------------------------------------------------------------------------
describe("resource access (fail-closed)", () => {
  it("grants only resources that are both valid and enabled", () => {
    const granted = resolveGrantedResources([
      { resource: "invoices", enabled: 1 },
      { resource: "payments", enabled: 0 }, // explicitly disabled
      { resource: "payroll", enabled: 1 }, // not a real vendor-portal resource
    ])
    expect(granted).toEqual(["invoices"])
  })

  it("returns nothing when there are no grants", () => {
    expect(resolveGrantedResources([])).toEqual([])
  })

  it("preserves canonical resource ordering regardless of input order", () => {
    const granted = resolveGrantedResources([
      { resource: "messages", enabled: true },
      { resource: "purchase-orders", enabled: true },
    ])
    expect(granted).toEqual(["purchase-orders", "messages"])
  })
})

// ---------------------------------------------------------------------------
// Session tokens are domain-separated from every other auth plane.
// ---------------------------------------------------------------------------
describe("vendor-portal session tokens", () => {
  const payload: Omit<VendorPortalSessionPayload, "typ"> = {
    portalUserId: 1,
    tenantId: TENANT,
    vendorId: VENDOR,
    email: "vendor@example.com",
    name: "Vendor User",
  }

  it("round-trips a vendor token and preserves the tenant + vendor scope", async () => {
    const token = await createVendorPortalSessionToken(payload)
    const verified = await verifyVendorPortalSessionToken(token)
    expect(verified).toMatchObject({ typ: "vendor-portal", tenantId: TENANT, vendorId: VENDOR })
  })

  it("rejects a token signed with the internal (non-portal) key", async () => {
    // An internal token uses the base secret WITHOUT the domain suffix.
    const internalKey = new TextEncoder().encode(process.env.SESSION_SECRET!)
    const foreign = await new SignJWT({ ...payload, typ: "session" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(internalKey)
    expect(await verifyVendorPortalSessionToken(foreign)).toBeNull()
  })

  it("rejects a client-portal token (different domain suffix)", async () => {
    const clientKey = new TextEncoder().encode(`${process.env.SESSION_SECRET}:portal`)
    const foreign = await new SignJWT({ ...payload, typ: "portal" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(clientKey)
    expect(await verifyVendorPortalSessionToken(foreign)).toBeNull()
  })

  it("rejects a correctly-signed token that lacks the vendor-portal typ claim", async () => {
    const vendorKey = new TextEncoder().encode(`${process.env.SESSION_SECRET}:vendor-portal`)
    const noTyp = await new SignJWT({ ...payload })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(vendorKey)
    expect(await verifyVendorPortalSessionToken(noTyp)).toBeNull()
  })

  it("rejects a tampered token", async () => {
    const token = await createVendorPortalSessionToken(payload)
    expect(await verifyVendorPortalSessionToken(`${token}x`)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Store reads: every query is scoped by BOTH tenant_id AND vendor_id.
// ---------------------------------------------------------------------------
describe("store reads (tenant + vendor scoping)", () => {
  it("scopes shared-item reads to the tenant and vendor", async () => {
    await listItems(TENANT, VENDOR, "purchase-orders")
    expect(calls[0].sql).toContain("tenant_id = ?")
    expect(calls[0].sql).toContain("vendor_id = ?")
    expect(calls[0].params).toEqual([TENANT, VENDOR, "purchase-orders"])
  })

  it("scopes item counts to the tenant and vendor", async () => {
    results = [[{ resource: "invoices", n: 3 }]]
    const counts = await countItemsByResource(TENANT, VENDOR)
    expect(calls[0].params).toEqual([TENANT, VENDOR])
    expect(counts).toEqual({ invoices: 3 })
  })

  it("scopes message threads to the tenant and vendor", async () => {
    await listMessages(TENANT, VENDOR)
    expect(scopedByTenantAndVendor(calls[0].params)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Store writes: the acting tenant + vendor are stamped, not taken from input.
// ---------------------------------------------------------------------------
describe("store writes (tenant + vendor stamping)", () => {
  it("stamps tenant + vendor on a vendor-submitted invoice and marks the source", async () => {
    results = [{ insertId: 15 }]
    await submitVendorInvoice({
      tenantId: TENANT,
      vendorId: VENDOR,
      portalUserId: 1,
      authorName: "Vendor User",
      title: "INV-2026-001",
      amount: 1200,
      currency: "INR",
    })
    const insert = calls.find((c) => c.sql.includes("INSERT INTO vendor_portal_items"))!
    expect(scopedByTenantAndVendor(insert.params)).toBe(true)
    // The record is flagged as a vendor submission (meta) and cannot be
    // published under another vendor via input.
    const metaParam = insert.params.find((p) => typeof p === "string" && p.includes("vendor_submission"))
    expect(metaParam).toBeTruthy()
    expect(insert.sql).toContain("'Submitted'")
  })

  it("stamps tenant + vendor + author as 'vendor' on a new message", async () => {
    results = [{ insertId: 5 }]
    const msg = await createMessage({
      tenantId: TENANT,
      vendorId: VENDOR,
      authorType: "vendor",
      portalUserId: 1,
      authorName: "Vendor User",
      body: "hello",
    })
    expect(scopedByTenantAndVendor(calls[0].params)).toBe(true)
    expect(msg.author_type).toBe("vendor")
  })
})

// ---------------------------------------------------------------------------
// Authentication derives tenant + vendor from the account, never from input.
// ---------------------------------------------------------------------------
describe("authentication (session scope comes from the account)", () => {
  function candidate(overrides: Record<string, unknown> = {}) {
    return {
      id: 1,
      tenant_id: TENANT,
      vendor_id: VENDOR,
      email: "vendor@example.com",
      name: "Vendor User",
      status: "active",
      must_change_password: 0,
      last_login_at: null,
      password_hash: "hash:pw",
      locked_until: null,
      failed_attempts: 0,
      ...overrides,
    }
  }

  it("returns the account's own tenant + vendor on success", async () => {
    results = [[candidate()], { affectedRows: 1 }]
    passwordMock.verify.mockResolvedValueOnce(true)
    const res = await authenticateVendorUser("vendor@example.com", "pw")
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.user.tenant_id).toBe(TENANT)
      expect(res.user.vendor_id).toBe(VENDOR)
    }
    // The login bookkeeping UPDATE is tenant-scoped.
    const update = calls.find((c) => c.sql.includes("UPDATE vendor_portal_users"))!
    expect(update.params).toContain(TENANT)
  })

  it("rejects a wrong password and increments the tenant-scoped lockout counter", async () => {
    results = [[candidate()], { affectedRows: 1 }]
    passwordMock.verify.mockResolvedValueOnce(false)
    const res = await authenticateVendorUser("vendor@example.com", "wrong")
    expect(res).toEqual({ ok: false, reason: "invalid" })
    const update = calls.find(
      (c) => c.sql.includes("UPDATE vendor_portal_users") && c.sql.includes("failed_attempts = failed_attempts + 1"),
    )!
    expect(update.params).toContain(TENANT)
  })

  it("refuses login while the account is locked", async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    results = [[candidate({ locked_until: future, failed_attempts: 10 })]]
    const res = await authenticateVendorUser("vendor@example.com", "pw")
    expect(res).toEqual({ ok: false, reason: "locked" })
  })
})
