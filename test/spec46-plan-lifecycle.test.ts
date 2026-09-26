import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec46 — plan lifecycle write lock (read-only grace), failed renewal,
 * plan-module gating and the billing-contacts API (permission, cross-tenant,
 * validation, audit). Coupon caps and proration are covered in
 * billing-math.test.ts; this file covers the new surfaces.
 */

const mocks = vi.hoisted(() => ({
  billingGuard: vi.fn(),
  listBillingContacts: vi.fn(),
  createBillingContact: vi.fn(),
  updateBillingContact: vi.fn(),
  deleteBillingContact: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/settings/server", () => ({ getSettings: vi.fn() }))
vi.mock("@/lib/billing-guard", () => ({ billingGuard: mocks.billingGuard }))
vi.mock("@/lib/audit-log-store", () => ({ recordAuditLogFromRequest: mocks.audit }))
vi.mock("@/lib/billing/billing-engine", () => {
  class BillingError extends Error {
    status: number
    fields?: Record<string, string>
    constructor(message: string, status = 400, fields?: Record<string, string>) {
      super(message)
      this.status = status
      this.fields = fields
    }
  }
  return {
    BillingError,
    listBillingContacts: mocks.listBillingContacts,
    createBillingContact: mocks.createBillingContact,
    updateBillingContact: mocks.updateBillingContact,
    deleteBillingContact: mocks.deleteBillingContact,
  }
})

import {
  deriveWriteAccess,
  shouldCheckWriteLock,
  writeAccessFromStatus,
  WRITE_LOCK_CODE,
} from "@/lib/billing/write-lock-model"
import { billingWriteLockGate, __resetWriteLockCache } from "@/lib/billing/edge-write-lock"
import { planAllowsModule } from "@/lib/module-access"
import { BillingError } from "@/lib/billing/billing-engine"
import { GET as listContacts, POST as createContact } from "@/app/api/billing/contacts/route"
import { PATCH as patchContact, DELETE as deleteContact } from "@/app/api/billing/contacts/[id]/route"
import { NextRequest } from "next/server"

const baseRow = {
  status: "active",
  term: "monthly",
  auto_renew: 1,
  cancel_at_period_end: 0,
  trial_end_date: null,
  current_period_start: "2026-08-01",
  current_period_end: "2026-09-01",
  past_due_days: 7,
  grace_days: 14,
  suspend_days: 30,
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetWriteLockCache()
  process.env.SESSION_SECRET = "test-secret-for-spec46-write-lock"
  mocks.audit.mockResolvedValue(undefined)
})

describe("write access by lifecycle status", () => {
  it("trial, active and past_due are writable; grace is read-only; suspended/expired are locked", () => {
    for (const s of ["trial", "active", "past_due"] as const) expect(writeAccessFromStatus(s).writable).toBe(true)
    const grace = writeAccessFromStatus("grace")
    expect(grace.writable).toBe(false)
    expect(grace.reason).toMatch(/read-only grace/)
    for (const s of ["suspended", "expired", "cancelled"] as const) expect(writeAccessFromStatus(s).writable).toBe(false)
  })

  it("tenants without an engine subscription stay writable (starter floor)", () => {
    expect(deriveWriteAccess(null, "2026-09-26").writable).toBe(true)
  })

  it("malformed rows never lock a tenant out", () => {
    expect(deriveWriteAccess({ ...baseRow, current_period_end: "garbage" }, "2026-09-26").writable).toBe(true)
  })
})

describe("failed renewal (charge_required) walks past_due → grace → suspended → expired", () => {
  const row = { ...baseRow, renewal_mode: "charge_required", last_payment_at: null }
  it.each([
    ["2026-08-20", "active", true],
    ["2026-09-03", "past_due", true],
    ["2026-09-10", "grace", false],
    ["2026-09-30", "suspended", false],
    ["2026-11-15", "expired", false],
  ])("on %s status is %s (writable=%s)", (now, status, writable) => {
    const access = deriveWriteAccess(row, now)
    expect(access.status).toBe(status)
    expect(access.writable).toBe(writable)
  })

  it("optimistic auto-renew rolls the period forward and stays writable", () => {
    expect(deriveWriteAccess(baseRow, "2026-12-15")).toMatchObject({ status: "active", writable: true })
  })

  it("an admin suspension is not lifted by time passing", () => {
    const access = deriveWriteAccess({ ...row, status: "suspended" }, "2026-08-20")
    expect(access.status).toBe("suspended")
    expect(access.writable).toBe(false)
  })
})

describe("which requests the lock applies to", () => {
  it("only tenant mutations on non-exempt APIs", () => {
    expect(shouldCheckWriteLock({ method: "POST", pathname: "/api/finance/journals" })).toBe(true)
    expect(shouldCheckWriteLock({ method: "GET", pathname: "/api/finance/journals" })).toBe(false)
    expect(shouldCheckWriteLock({ method: "POST", pathname: "/api/billing/portal/pay" })).toBe(false)
    expect(shouldCheckWriteLock({ method: "POST", pathname: "/api/auth/logout" })).toBe(false)
    expect(shouldCheckWriteLock({ method: "DELETE", pathname: "/dashboard" })).toBe(false)
    expect(
      shouldCheckWriteLock({ method: "POST", pathname: "/api/finance/journals", platformRole: "super_admin" }),
    ).toBe(false)
  })

  it("does not treat a lookalike prefix as exempt", () => {
    expect(shouldCheckWriteLock({ method: "POST", pathname: "/api/billingx/hack" })).toBe(true)
  })
})

describe("middleware write-lock gate", () => {
  const req = (method: string, path: string) => new NextRequest(`http://localhost${path}`, { method })
  const feed = (state: object, ok = true) =>
    vi.fn(async () => new Response(JSON.stringify(state), { status: ok ? 200 : 500 })) as unknown as typeof fetch

  it("returns 423 for a grace tenant's mutation", async () => {
    const f = feed(writeAccessFromStatus("grace"))
    const res = await billingWriteLockGate(req("POST", "/api/hr/employees"), { tenantId: 7 }, "rid-1", f)
    expect(res?.status).toBe(423)
    const body = await res!.json()
    expect(body.code).toBe(WRITE_LOCK_CODE)
    expect(body.subscriptionStatus).toBe("grace")
  })

  it("lets reads and billing payments through without consulting the feed", async () => {
    const f = feed(writeAccessFromStatus("grace"))
    expect(await billingWriteLockGate(req("GET", "/api/hr/employees"), { tenantId: 7 }, "r", f)).toBeNull()
    expect(await billingWriteLockGate(req("POST", "/api/billing/portal"), { tenantId: 7 }, "r", f)).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it("asks the feed for the session tenant only and caches per tenant", async () => {
    const f = feed(writeAccessFromStatus("active"))
    await billingWriteLockGate(req("POST", "/api/hr/employees"), { tenantId: 7 }, "r", f)
    await billingWriteLockGate(req("POST", "/api/hr/employees"), { tenantId: 7 }, "r", f)
    await billingWriteLockGate(req("POST", "/api/hr/employees"), { tenantId: 8 }, "r", f)
    const urls = (f as any).mock.calls.map((c: any[]) => String(c[0]))
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain("tenantId=7")
    expect(urls[1]).toContain("tenantId=8")
  })

  it("fails open when the feed is down", async () => {
    const f = feed({}, false)
    expect(await billingWriteLockGate(req("POST", "/api/hr/employees"), { tenantId: 9 }, "r", f)).toBeNull()
    const thrower = vi.fn(async () => {
      throw new Error("down")
    }) as unknown as typeof fetch
    expect(await billingWriteLockGate(req("POST", "/api/hr/employees"), { tenantId: 10 }, "r", thrower)).toBeNull()
  })
})

describe("plan-module gating", () => {
  const ent = (modules: string[]) => ({ modules, feature_flags: [] }) as any
  it("blocks modules outside the plan, allows included ones", () => {
    expect(planAllowsModule(ent(["crm"]), "finance")).toBe(false)
    expect(planAllowsModule(ent(["finance"]), "/finance/journals")).toBe(true)
  })
  it("unsubscribed tenants and unmapped slugs are not gated", () => {
    expect(planAllowsModule(null, "finance")).toBe(true)
    expect(planAllowsModule(ent([]), "settings")).toBe(true)
  })
})

describe("billing contacts API", () => {
  const json = (body: unknown, method = "POST") =>
    new Request("http://localhost/api/billing/contacts", {
      method,
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    })
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

  it("returns 403 and touches nothing for non-admins", async () => {
    mocks.billingGuard.mockRejectedValue(new Error("redirect"))
    expect((await listContacts()).status).toBe(403)
    expect((await createContact(json({ name: "A", email: "a@x.io" }))).status).toBe(403)
    expect((await patchContact(json({}, "PATCH"), ctx("1"))).status).toBe(403)
    expect((await deleteContact(json({}, "DELETE"), ctx("1"))).status).toBe(403)
    expect(mocks.createBillingContact).not.toHaveBeenCalled()
    expect(mocks.deleteBillingContact).not.toHaveBeenCalled()
  })

  it("creates a contact and writes an audit entry", async () => {
    mocks.billingGuard.mockResolvedValue({ userId: 1, tenantId: 5 })
    mocks.createBillingContact.mockResolvedValue({ id: 3, name: "A", email: "a@x.io", role: "billing", is_primary: true })
    const res = await createContact(json({ name: "A", email: "a@x.io" }))
    expect(res.status).toBe(201)
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "billing.contact.create" }))
  })

  it("surfaces validation and duplicate errors from the engine", async () => {
    mocks.billingGuard.mockResolvedValue({ userId: 1, tenantId: 5 })
    mocks.createBillingContact.mockRejectedValue(new BillingError("Validation failed", 400, { email: "Invalid email" }))
    const bad = await createContact(json({ name: "A", email: "nope" }))
    expect(bad.status).toBe(400)
    expect((await bad.json()).fields.email).toBe("Invalid email")

    mocks.createBillingContact.mockRejectedValue(new BillingError("Contact already exists", 409))
    expect((await createContact(json({ name: "A", email: "a@x.io" }))).status).toBe(409)
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it("rejects malformed bodies and ids before hitting the engine", async () => {
    mocks.billingGuard.mockResolvedValue({ userId: 1, tenantId: 5 })
    expect((await createContact(json([1, 2]))).status).toBe(400)
    expect((await patchContact(json({}, "PATCH"), ctx("abc"))).status).toBe(400)
    expect((await deleteContact(json({}, "DELETE"), ctx("-1"))).status).toBe(400)
    expect(mocks.updateBillingContact).not.toHaveBeenCalled()
  })

  it("answers 404 for another tenant's contact without leaking it", async () => {
    mocks.billingGuard.mockResolvedValue({ userId: 1, tenantId: 5 })
    mocks.deleteBillingContact.mockRejectedValue(new BillingError("Billing contact not found", 404))
    const res = await deleteContact(json({}, "DELETE"), ctx("999"))
    expect(res.status).toBe(404)
    expect(mocks.audit).not.toHaveBeenCalled()
  })
})
