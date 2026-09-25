import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec30 (#173) — affiliate route handlers: permission gates, server-derived
 * scope (a portal caller can never select another partner), validation, audit
 * (only on real changes) and idempotency. The store is mocked; its behavior is
 * covered in affiliate-store.test.ts.
 */

const m = vi.hoisted(() => ({
  staff: vi.fn(),
  superAdmin: vi.fn(),
  audit: vi.fn(),
  session: vi.fn(),
  store: {
    getAffiliatePortal: vi.fn(),
    resolveAffiliate: vi.fn(),
    createLink: vi.fn(),
    setLinkStatus: vi.fn(),
    listLinks: vi.fn(),
    listPayouts: vi.fn(),
    partnerBalances: vi.fn(),
    createPayout: vi.fn(),
    transitionPayout: vi.fn(),
    syncConversions: vi.fn(),
    getPartner: vi.fn(),
  },
}))

vi.mock("@/lib/platform-guard", () => ({ requirePlatformStaff: m.staff, requirePlatformSuperAdmin: m.superAdmin }))
vi.mock("@/lib/platform-roles", () => ({ recordPlatformAudit: m.audit }))
vi.mock("@/lib/auth", () => ({ getSession: m.session }))
vi.mock("@/lib/affiliates/store", () => ({
  getAffiliatePortal: m.store.getAffiliatePortal,
  resolveAffiliate: m.store.resolveAffiliate,
  createLink: m.store.createLink,
  setLinkStatus: m.store.setLinkStatus,
  listLinks: m.store.listLinks,
  listPayouts: m.store.listPayouts,
  partnerBalances: m.store.partnerBalances,
  createPayout: m.store.createPayout,
  transitionPayout: m.store.transitionPayout,
  syncConversions: m.store.syncConversions,
}))
vi.mock("@/lib/partners/store", () => ({ getPartner: m.store.getPartner }))

const { PartnerError } = await import("@/lib/partners/model")

const portalRoute = await import("@/app/api/partner/affiliate/route")
const portalLinksRoute = await import("@/app/api/partner/affiliate/links/route")
const portalLinkRoute = await import("@/app/api/partner/affiliate/links/[id]/route")
const platformLinkRoute = await import("@/app/api/platform/affiliate/links/[id]/route")
const payoutsRoute = await import("@/app/api/platform/affiliate/payouts/route")
const payoutRoute = await import("@/app/api/platform/affiliate/payouts/[id]/route")
const partnerAffiliateRoute = await import("@/app/api/platform/partners/[id]/affiliate/route")

const ALLOW = { ok: true, ctx: { userId: 1 }, session: { userId: 1, email: "root@platform.test" } }
const DENY = { ok: false, status: 403, reason: "Forbidden" }

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
  m.session.mockResolvedValue({ userId: 50, email: "affiliate@x.test" })
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("platform permission gates", () => {
  it.each([
    ["list payouts (staff)", () => payoutsRoute.GET(req("GET")), "staff"],
    ["view partner affiliate (staff)", () => partnerAffiliateRoute.GET(req("GET"), ctx(2)), "staff"],
    ["create payout (super)", () => payoutsRoute.POST(req("POST", { partnerId: 2 }, { "idempotency-key": "payout-key-000001" })), "super"],
    ["transition payout (super)", () => payoutRoute.PATCH(req("PATCH", { action: "void", reason: "bad" }), ctx(3)), "super"],
    ["platform disable link (super)", () => platformLinkRoute.PATCH(req("PATCH", { status: "disabled" }), ctx(4)), "super"],
    ["create link for partner (super)", () => partnerAffiliateRoute.POST(req("POST", {}), ctx(2)), "super"],
  ])("%s is refused without the right role", async (_n, call, level) => {
    if (level === "staff") m.staff.mockResolvedValue(DENY)
    else m.superAdmin.mockResolvedValue(DENY)
    const res = await call()
    expect(res.status).toBe(403)
    expect(storeCalls()).toBe(0)
    expect(m.audit).not.toHaveBeenCalled()
  })
})

describe("affiliate portal is pinned to the session user", () => {
  it("requires a session", async () => {
    m.session.mockResolvedValue(null)
    expect((await portalRoute.GET()).status).toBe(401)
    expect(m.store.getAffiliatePortal).not.toHaveBeenCalled()
  })

  it("loads the portal for the session user only and never caches", async () => {
    m.store.getAffiliatePortal.mockResolvedValue({ affiliate: { name: "Acme" }, links: [] })
    const res = await portalRoute.GET()
    expect(res.status).toBe(200)
    expect(m.store.getAffiliatePortal.mock.calls[0][0]).toBe(50)
    expect(res.headers.get("cache-control") ?? "").toMatch(/no-store/)
  })

  it("maps a non-partner to 403 and hides internals on a 500", async () => {
    m.store.getAffiliatePortal.mockRejectedValueOnce(new PartnerError("No active affiliate access", "PARTNER_ACCESS_DENIED", 403))
    expect((await portalRoute.GET()).status).toBe(403)
    m.store.getAffiliatePortal.mockRejectedValueOnce(new Error("ECONNREFUSED 10.0.0.5:3306 password=abc"))
    const res = await portalRoute.GET()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toMatch(/ECONNREFUSED|password/)
  })
})

describe("portal link creation ignores any body partnerId", () => {
  it("creates for the resolved partner, not the requested one", async () => {
    m.store.resolveAffiliate.mockResolvedValue(9)
    m.store.createLink.mockResolvedValue({ link: { id: 3 }, replayed: false })
    const res = await portalLinksRoute.POST(req("POST", { label: "Blog", partnerId: 999 }, { "idempotency-key": "aff-link-key-01" }))
    expect(res.status).toBe(201)
    const arg = m.store.createLink.mock.calls[0][0]
    expect(arg.partnerId).toBe(9)
    expect(arg).not.toHaveProperty("partnerId", 999)
    expect(arg.idempotencyKey).toBe("aff-link-key-01")
    expect(m.audit.mock.calls[0][0]).toMatchObject({ action: "affiliate_link_created", detail: { by: "affiliate", partnerId: 9 } })
  })

  it("does not re-audit an idempotent replay", async () => {
    m.store.resolveAffiliate.mockResolvedValue(9)
    m.store.createLink.mockResolvedValue({ link: { id: 3 }, replayed: true })
    const res = await portalLinksRoute.POST(req("POST", { label: "Blog" }))
    expect(res.status).toBe(200)
    expect(m.audit).not.toHaveBeenCalled()
  })

  it("rejects an over-long label before touching the store", async () => {
    m.store.resolveAffiliate.mockResolvedValue(9)
    const res = await portalLinksRoute.POST(req("POST", { label: "x".repeat(81) }))
    expect(res.status).toBe(400)
    expect(m.store.createLink).not.toHaveBeenCalled()
  })

  it("propagates a denied affiliate as 403", async () => {
    m.store.resolveAffiliate.mockRejectedValue(new PartnerError("No active affiliate access", "PARTNER_ACCESS_DENIED", 403))
    expect((await portalLinksRoute.POST(req("POST", {}))).status).toBe(403)
    expect(m.store.createLink).not.toHaveBeenCalled()
  })
})

describe("link status changes are scoped", () => {
  it("portal PATCH pins the scope to the caller's partner", async () => {
    m.store.resolveAffiliate.mockResolvedValue(9)
    m.store.setLinkStatus.mockResolvedValue({ link: { id: 4, partnerId: 9 }, replayed: false, previous: "active" })
    const res = await portalLinkRoute.PATCH(req("PATCH", { status: "disabled" }), ctx(4))
    expect(res.status).toBe(200)
    // 3rd arg is the scope partner id — must be the resolved one, not null
    expect(m.store.setLinkStatus.mock.calls[0]).toEqual([4, "disabled", 9])
    expect(m.audit.mock.calls[0][0]).toMatchObject({ action: "affiliate_link_status_changed", detail: { by: "affiliate" } })
  })

  it("a portal caller gets 404 for another partner's link", async () => {
    m.store.resolveAffiliate.mockResolvedValue(9)
    m.store.setLinkStatus.mockRejectedValue(new PartnerError("Link not found", "NOT_FOUND", 404))
    expect((await portalLinkRoute.PATCH(req("PATCH", { status: "disabled" }), ctx(4))).status).toBe(404)
  })

  it("platform PATCH is unscoped (null) and validates the id and body", async () => {
    m.store.setLinkStatus.mockResolvedValue({ link: { id: 4, partnerId: 2 }, replayed: false, previous: "active" })
    await platformLinkRoute.PATCH(req("PATCH", { status: "disabled" }), ctx(4))
    expect(m.store.setLinkStatus.mock.calls[0]).toEqual([4, "disabled", null])
    expect(m.audit.mock.calls[0][0]).toMatchObject({ action: "affiliate_link_status_changed", detail: { by: "platform" } })

    expect((await platformLinkRoute.PATCH(req("PATCH", { status: "nope" }), ctx(4))).status).toBe(400)
    expect((await platformLinkRoute.PATCH(req("PATCH", { status: "disabled" }), ctx("-1"))).status).toBe(400)
  })
})

describe("payouts require money-movement safeguards", () => {
  it("POST requires a valid Idempotency-Key and a positive partnerId", async () => {
    expect((await payoutsRoute.POST(req("POST", { partnerId: 2 }))).status).toBe(400) // no key
    expect((await payoutsRoute.POST(req("POST", { partnerId: 2 }, { "idempotency-key": "x" }))).status).toBe(400) // key too short
    expect((await payoutsRoute.POST(req("POST", { partnerId: 0 }, { "idempotency-key": "payout-key-000001" }))).status).toBe(400)
    expect(m.store.createPayout).not.toHaveBeenCalled()
  })

  it("creates a payout, passing the key through and auditing once", async () => {
    m.store.createPayout.mockResolvedValue({ payout: { id: 7, amount: "12.00" }, replayed: false, entries: 3 })
    const res = await payoutsRoute.POST(req("POST", { partnerId: 2, currency: "usd" }, { "idempotency-key": "payout-key-000001" }))
    expect(res.status).toBe(201)
    expect(m.store.createPayout.mock.calls[0][0]).toMatchObject({ partnerId: 2, currency: "USD", idempotencyKey: "payout-key-000001", actorUserId: 1 })
    expect(m.audit.mock.calls[0][0]).toMatchObject({ action: "affiliate_payout_created" })
  })

  it("does not audit a replayed payout", async () => {
    m.store.createPayout.mockResolvedValue({ payout: { id: 7 }, replayed: true, entries: 0 })
    const res = await payoutsRoute.POST(req("POST", { partnerId: 2 }, { "idempotency-key": "payout-key-000001" }))
    expect(res.status).toBe(200)
    expect(m.audit).not.toHaveBeenCalled()
  })

  it("GET validates a supplied partnerId filter", async () => {
    m.store.listPayouts.mockResolvedValue([])
    expect((await payoutsRoute.GET(req("GET"))).status).toBe(200)
    expect(m.store.listPayouts).toHaveBeenCalledWith(null)
    const res = await payoutsRoute.GET(new Request("http://localhost/api/x?partnerId=abc") as any)
    expect(res.status).toBe(400)
  })

  it("PATCH validates the action and audits paid vs void distinctly", async () => {
    m.store.transitionPayout.mockResolvedValue({ payout: { id: 3, partnerId: 2, amount: "12.00", currency: "USD" }, replayed: false, previousStatus: "pending" })
    await payoutRoute.PATCH(req("PATCH", { action: "mark_paid", reference: "wire-12345" }), ctx(3))
    expect(m.audit.mock.calls[0][0]).toMatchObject({ action: "affiliate_payout_paid" })

    vi.clearAllMocks()
    m.superAdmin.mockResolvedValue(ALLOW)
    m.store.transitionPayout.mockResolvedValue({ payout: { id: 3, partnerId: 2, amount: "12.00", currency: "USD" }, replayed: false, previousStatus: "pending" })
    await payoutRoute.PATCH(req("PATCH", { action: "void", reason: "duplicate payout" }), ctx(3))
    expect(m.audit.mock.calls[0][0]).toMatchObject({ action: "affiliate_payout_voided" })

    expect((await payoutRoute.PATCH(req("PATCH", { action: "mark_paid", reference: "no" }), ctx(3))).status).toBe(400)
    expect((await payoutRoute.PATCH(req("PATCH", { action: "delete" }), ctx(3))).status).toBe(400)
  })

  it("surfaces an invalid transition as 409", async () => {
    m.store.transitionPayout.mockRejectedValue(new PartnerError("Payout is already paid", "INVALID_PAYOUT_TRANSITION", 409))
    const res = await payoutRoute.PATCH(req("PATCH", { action: "void", reason: "too late" }), ctx(3))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "INVALID_PAYOUT_TRANSITION" })
  })
})

describe("staff view of a partner's affiliate data", () => {
  it("syncs conversions then returns links, balances and payouts", async () => {
    m.store.getPartner.mockResolvedValue({ id: 2, terms: { revenueShareBps: 2000 } })
    m.store.syncConversions.mockResolvedValue({ scanned: 0, updated: 0 })
    m.store.listLinks.mockResolvedValue([{ id: 1 }])
    m.store.partnerBalances.mockResolvedValue([{ currency: "USD", available: "12.00" }])
    m.store.listPayouts.mockResolvedValue([])
    const res = await partnerAffiliateRoute.GET(req("GET"), ctx(2))
    expect(res.status).toBe(200)
    expect(m.store.partnerBalances).toHaveBeenCalledWith(2, 2000)
    expect(res.headers.get("cache-control") ?? "").toMatch(/no-store/)
    expect(await res.json()).toMatchObject({ links: [{ id: 1 }], balances: [{ currency: "USD" }] })
  })

  it("rejects a bad partner id", async () => {
    expect((await partnerAffiliateRoute.GET(req("GET"), ctx("abc"))).status).toBe(400)
    expect(storeCalls()).toBe(0)
  })
})
