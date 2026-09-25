import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec29 (#172) — partner route handlers: permission gates, validation,
 * audit (only on real changes), idempotency and server-derived scope. The
 * store is mocked; its behavior is covered in partners-store.test.ts.
 */

const m = vi.hoisted(() => ({
  staff: vi.fn(),
  superAdmin: vi.fn(),
  audit: vi.fn(),
  session: vi.fn(),
  refundInvoice: vi.fn(),
  store: {
    listPartners: vi.fn(),
    createPartner: vi.fn(),
    getPartnerDetail: vi.fn(),
    updatePartner: vi.fn(),
    addMember: vi.fn(),
    revokeMember: vi.fn(),
    attributeTenant: vi.fn(),
    cancelReferral: vi.fn(),
    settleCommissions: vi.fn(),
    applyInvoiceClawback: vi.fn(),
    getPartnerDashboard: vi.fn(),
  },
}))

vi.mock("@/lib/platform-guard", () => ({ requirePlatformStaff: m.staff, requirePlatformSuperAdmin: m.superAdmin }))
vi.mock("@/lib/platform-roles", () => ({ recordPlatformAudit: m.audit }))
vi.mock("@/lib/auth", () => ({ getSession: m.session }))
vi.mock("@/lib/partners/store", () => m.store)
vi.mock("@/lib/platform-console", () => {
  class InvoiceRefundError extends Error {
    constructor(message: string, public status = 400) {
      super(message)
    }
  }
  return { InvoiceRefundError, refundInvoice: m.refundInvoice, markInvoicePaid: vi.fn() }
})

const { PartnerError } = await import("@/lib/partners/model")
const partnersRoute = await import("@/app/api/platform/partners/route")
const partnerRoute = await import("@/app/api/platform/partners/[id]/route")
const membersRoute = await import("@/app/api/platform/partners/[id]/members/route")
const referralsRoute = await import("@/app/api/platform/partners/[id]/referrals/route")
const cancelRoute = await import("@/app/api/platform/partners/referrals/[id]/route")
const settleRoute = await import("@/app/api/platform/partners/settle/route")
const dashboardRoute = await import("@/app/api/partner/dashboard/route")
const cronRoute = await import("@/app/api/cron/partner-settlement/route")
const invoicesRoute = await import("@/app/api/platform/invoices/route")

const ALLOW = { ok: true, ctx: { userId: 1 }, session: { userId: 1, email: "root@platform.test" } }
const DENY = { ok: false, status: 403, reason: "Forbidden" }
const TERMS = { revenueShareBps: 2000, refundWindowDays: 30, contractStart: "2027-01-01" }

const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/x", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }) as any
const ctx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) })
const storeCalls = () => Object.values(m.store).reduce((n, f) => n + f.mock.calls.length, 0)

beforeEach(() => {
  vi.clearAllMocks()
  m.staff.mockResolvedValue(ALLOW)
  m.superAdmin.mockResolvedValue(ALLOW)
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("permissions", () => {
  it.each([
    ["create partner", () => partnersRoute.POST(req("POST", { name: "Acme", terms: TERMS }))],
    ["update partner", () => partnerRoute.PATCH(req("PATCH", { status: "suspended" }), ctx(1))],
    ["grant member", () => membersRoute.POST(req("POST", { userId: 5 }), ctx(1))],
    ["revoke member", () => membersRoute.DELETE(req("DELETE", { userId: 5 }), ctx(1))],
    ["attribute tenant", () => referralsRoute.POST(req("POST", { tenantId: 9, ownership: "partner" }), ctx(1))],
    ["cancel referral", () => cancelRoute.DELETE(req("DELETE", { reason: "churn" }), ctx(1))],
    ["settle", () => settleRoute.POST()],
    ["refund", () => invoicesRoute.POST(req("POST", { invoiceId: 1, amount: 5 }, { "idempotency-key": "refund-key-01" }))],
  ])("%s requires platform super admin", async (_name, call) => {
    m.superAdmin.mockResolvedValue(DENY)
    const res = await call()
    expect(res.status).toBe(403)
    expect(storeCalls()).toBe(0)
    expect(m.refundInvoice).not.toHaveBeenCalled()
    expect(m.audit).not.toHaveBeenCalled()
  })

  it("read-only partner views require platform staff", async () => {
    m.staff.mockResolvedValue({ ok: false, status: 401, reason: "Not authenticated" })
    expect((await partnersRoute.GET()).status).toBe(401)
    expect((await partnerRoute.GET(req("GET"), ctx(1))).status).toBe(401)
    expect(storeCalls()).toBe(0)
  })
})

describe("partner creation and updates", () => {
  it("validates before touching the store", async () => {
    for (const body of ["{not json", { name: "A", terms: TERMS }, { name: "Acme", terms: { ...TERMS, revenueShareBps: 9000 } }]) {
      const res = await partnersRoute.POST(req("POST", body))
      expect(res.status).toBe(400)
    }
    expect(m.store.createPartner).not.toHaveBeenCalled()
  })

  it("passes a valid Idempotency-Key through and audits only the first create", async () => {
    m.store.createPartner.mockResolvedValueOnce({ partner: { id: 7 }, replayed: false })
    m.store.createPartner.mockResolvedValueOnce({ partner: { id: 7 }, replayed: true })
    const first = await partnersRoute.POST(req("POST", { name: "Acme", terms: TERMS }, { "idempotency-key": "create-acme-1" }))
    const second = await partnersRoute.POST(req("POST", { name: "Acme", terms: TERMS }, { "idempotency-key": "create-acme-1" }))
    expect([first.status, second.status]).toEqual([201, 200])
    expect(m.store.createPartner.mock.calls[0][1]).toBe(1)
    expect(m.store.createPartner.mock.calls[0][2]).toBe("create-acme-1")
    expect(m.audit).toHaveBeenCalledTimes(1)
    expect(m.audit.mock.calls[0][0]).toMatchObject({ action: "partner_created", actorUserId: 1 })
  })

  it("drops malformed Idempotency-Keys instead of trusting them", async () => {
    m.store.createPartner.mockResolvedValue({ partner: { id: 7 }, replayed: false })
    await partnersRoute.POST(req("POST", { name: "Acme", terms: TERMS }, { "idempotency-key": "x" }))
    expect(m.store.createPartner.mock.calls[0][2]).toBeNull()
  })

  it("maps status changes to specific audit actions and surfaces domain errors", async () => {
    m.store.updatePartner.mockResolvedValue({ before: { status: "active" }, after: { status: "suspended" } })
    expect((await partnerRoute.PATCH(req("PATCH", { status: "suspended" }), ctx(3))).status).toBe(200)
    expect(m.audit.mock.calls[0][0]).toMatchObject({ action: "partner_suspended" })

    m.store.updatePartner.mockRejectedValue(new PartnerError("Terminated partners cannot be reactivated", "INVALID_TRANSITION", 409))
    const res = await partnerRoute.PATCH(req("PATCH", { status: "active" }), ctx(3))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "INVALID_TRANSITION" })
  })

  it("rejects bad ids", async () => {
    expect((await partnerRoute.PATCH(req("PATCH", { status: "active" }), ctx("abc"))).status).toBe(400)
    expect((await partnerRoute.GET(req("GET"), ctx(-1))).status).toBe(400)
    expect(storeCalls()).toBe(0)
  })
})

describe("members and referrals", () => {
  it("audits a grant once; a repeated grant is a 200 no-op", async () => {
    m.store.addMember.mockResolvedValueOnce({ granted: true }).mockResolvedValueOnce({ granted: false })
    expect((await membersRoute.POST(req("POST", { userId: 5 }), ctx(2))).status).toBe(201)
    expect((await membersRoute.POST(req("POST", { userId: 5 }), ctx(2))).status).toBe(200)
    expect(m.audit).toHaveBeenCalledTimes(1)
    expect(m.audit.mock.calls[0][0]).toMatchObject({ action: "partner_member_granted", targetUserId: 5, detail: { partnerId: 2 } })
  })

  it("audits revocation and validates the user id", async () => {
    m.store.revokeMember.mockResolvedValue({ revoked: true })
    expect((await membersRoute.DELETE(req("DELETE", { userId: 5 }), ctx(2))).status).toBe(200)
    expect(m.audit.mock.calls[0][0]).toMatchObject({ action: "partner_member_revoked" })
    expect((await membersRoute.POST(req("POST", { userId: "5; DROP" }), ctx(2))).status).toBe(400)
  })

  it("requires a literal boolean to transfer and audits transfers distinctly", async () => {
    m.store.attributeTenant.mockResolvedValue({ referral: { id: 4, tenantId: 9 }, replayed: false, previous: { partnerId: 1 } })
    await referralsRoute.POST(req("POST", { tenantId: 9, ownership: "partner", transfer: "true" }), ctx(2))
    expect(m.store.attributeTenant.mock.calls[0][0]).toMatchObject({ transfer: false, partnerId: 2, tenantId: 9, actorUserId: 1 })
    expect(m.audit.mock.calls[0][0]).toMatchObject({ action: "partner_referral_transferred" })
    expect((await referralsRoute.POST(req("POST", { tenantId: 9, ownership: "owner" }), ctx(2))).status).toBe(400)
  })

  it("requires a cancellation reason", async () => {
    expect((await cancelRoute.DELETE(req("DELETE", { reason: "x" }), ctx(4))).status).toBe(400)
    expect(m.store.cancelReferral).not.toHaveBeenCalled()
    m.store.cancelReferral.mockResolvedValue({ referral: { id: 4, partnerId: 2, tenantId: 9 }, replayed: true })
    expect((await cancelRoute.DELETE(req("DELETE", { reason: "customer churned" }), ctx(4))).status).toBe(200)
    expect(m.audit).not.toHaveBeenCalled()
  })
})

describe("settlement", () => {
  it("uses the server date, never client input", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2027-05-10T12:00:00Z"))
    m.store.settleCommissions.mockResolvedValue({ settled: [], skipped: [], failed: [] })
    await settleRoute.POST()
    expect(m.store.settleCommissions).toHaveBeenCalledWith("2027-05-10", 1)
    vi.useRealTimers()
  })

  it("cron requires the bearer secret when configured", async () => {
    process.env.CRON_SECRET = "cron-secret-value"
    try {
      m.store.settleCommissions.mockResolvedValue({ settled: [], skipped: [], failed: [] })
      expect((await cronRoute.GET(new Request("http://x"))).status).toBe(401)
      expect((await cronRoute.GET(new Request("http://x", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401)
      expect(m.store.settleCommissions).not.toHaveBeenCalled()
      const ok = await cronRoute.GET(new Request("http://x", { headers: { authorization: "Bearer cron-secret-value" } }))
      expect(ok.status).toBe(200)
      expect(m.store.settleCommissions.mock.calls[0][1]).toBeNull()
    } finally {
      delete process.env.CRON_SECRET
    }
  })
})

describe("partner dashboard", () => {
  it("requires a session and scopes strictly to the session user", async () => {
    m.session.mockResolvedValue(null)
    expect((await dashboardRoute.GET()).status).toBe(401)
    m.session.mockResolvedValue({ userId: 50, tenantId: 3 })
    m.store.getPartnerDashboard.mockResolvedValue({ partner: { id: 2 }, referrals: [], commissions: [] })
    const res = await dashboardRoute.GET()
    expect(res.status).toBe(200)
    expect(m.store.getPartnerDashboard).toHaveBeenCalledWith(50)
    expect(res.headers.get("cache-control") ?? "").toMatch(/no-store|private/)
  })

  it("returns 403 for non-partners and a generic 500 without internals", async () => {
    m.session.mockResolvedValue({ userId: 50 })
    m.store.getPartnerDashboard.mockRejectedValueOnce(new PartnerError("Not a partner", "NOT_A_PARTNER", 403))
    expect((await dashboardRoute.GET()).status).toBe(403)
    m.store.getPartnerDashboard.mockRejectedValueOnce(new Error("ECONNREFUSED 10.0.0.5:3306 password=abc"))
    const res = await dashboardRoute.GET()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toMatch(/ECONNREFUSED|password/)
  })
})

describe("refund triggers clawback", () => {
  const refund = (body: unknown = { invoiceId: 11, amount: 25 }, key = "refund-key-01") =>
    invoicesRoute.POST(req("POST", body, key ? { "idempotency-key": key } : {}))

  it("requires an Idempotency-Key and a valid amount", async () => {
    expect((await refund(undefined, "")).status).toBe(400)
    expect((await refund({ invoiceId: 11, amount: 1.234 })).status).toBe(400)
    expect(m.refundInvoice).not.toHaveBeenCalled()
  })

  it("claws back after the refund and audits both", async () => {
    m.refundInvoice.mockResolvedValue({ replayed: false, tenantId: 9, refundedAmount: "25.00" })
    m.store.applyInvoiceClawback.mockResolvedValue({ clawbacks: [{ partnerId: 2, amount: "-5.00" }] })
    const res = await refund()
    expect(res.status).toBe(200)
    expect(m.store.applyInvoiceClawback).toHaveBeenCalledWith(11, 1)
    expect(m.audit.mock.calls.map((c) => c[0].action)).toEqual(["invoice_refunded", "partner_commission_clawback"])
  })

  it("keeps the refund audited when clawback fails and lets a replay retry it", async () => {
    m.refundInvoice.mockResolvedValueOnce({ replayed: false, tenantId: 9, refundedAmount: "25.00" })
    m.store.applyInvoiceClawback.mockRejectedValueOnce(new Error("lock wait timeout"))
    const failed = await refund()
    expect(failed.status).toBe(500)
    expect(await failed.json()).toMatchObject({ refunded: true })
    expect(m.audit.mock.calls.map((c) => c[0].action)).toEqual(["invoice_refunded"])

    m.refundInvoice.mockResolvedValueOnce({ replayed: true, tenantId: 9, refundedAmount: "25.00" })
    m.store.applyInvoiceClawback.mockResolvedValueOnce({ clawbacks: [{ partnerId: 2, amount: "-5.00" }] })
    const retry = await refund()
    expect(retry.status).toBe(200)
    expect(m.audit.mock.calls.map((c) => c[0].action)).toEqual(["invoice_refunded", "partner_commission_clawback"])
  })
})
