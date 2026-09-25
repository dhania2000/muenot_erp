import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec6 — API + permission surface for the SaaS revenue metrics endpoint.
 * The route is admin-only and tenant-scoped: a rejected guard yields 403 and
 * NEVER touches the metrics services; an authorized admin binds the session
 * tenant (never client input) before any tenant-scoped read.
 */

const mocks = vi.hoisted(() => ({
  billingGuard: vi.fn(),
  bindBillingTenant: vi.fn(),
  getSaasMetrics: vi.fn(),
  getPlatformTrialBalance: vi.fn(),
  getDeferredBalance: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/billing-guard", () => ({
  billingGuard: mocks.billingGuard,
  bindBillingTenant: mocks.bindBillingTenant,
}))
vi.mock("@/lib/billing/saas-metrics", () => ({ getSaasMetrics: mocks.getSaasMetrics }))
vi.mock("@/lib/billing/platform-ledger", () => ({ getPlatformTrialBalance: mocks.getPlatformTrialBalance }))
vi.mock("@/lib/billing/revenue-recognition", () => ({ getDeferredBalance: mocks.getDeferredBalance }))

import { GET } from "@/app/api/billing/metrics/route"

const req = (url = "http://localhost/api/billing/metrics") => new Request(url)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSaasMetrics.mockResolvedValue({ mrr: 250, arr: 3000, churnRatePct: 5, reconciled: true })
  mocks.getPlatformTrialBalance.mockResolvedValue({ balanced: true, accounts: [], totalDebit: 0, totalCredit: 0 })
  mocks.getDeferredBalance.mockResolvedValue({ deferred: 100, recognized: 20, total: 120 })
})

describe("GET /api/billing/metrics — permission", () => {
  it("returns 403 and calls no metrics service when the guard rejects (non-admin)", async () => {
    mocks.billingGuard.mockRejectedValue(new Error("redirect"))
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(mocks.bindBillingTenant).not.toHaveBeenCalled()
    expect(mocks.getSaasMetrics).not.toHaveBeenCalled()
  })
})

describe("GET /api/billing/metrics — authorized", () => {
  it("binds the session tenant and returns MRR/ARR/churn, trial balance and deferred position", async () => {
    const session = { userId: 1, tenantId: 7, role: "admin" }
    mocks.billingGuard.mockResolvedValue(session)

    const res = await GET(req("http://localhost/api/billing/metrics?as_of=2026-09-01"))
    expect(res.status).toBe(200)
    expect(mocks.bindBillingTenant).toHaveBeenCalledWith(session)
    expect(mocks.getSaasMetrics).toHaveBeenCalledWith("2026-09-01")

    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.metrics.mrr).toBe(250)
    expect(body.metrics.reconciled).toBe(true)
    expect(body.trialBalance.balanced).toBe(true)
    expect(body.deferred.deferred).toBe(100)
  })

  it("returns 500 when a downstream service throws (fail-safe, no partial body)", async () => {
    mocks.billingGuard.mockResolvedValue({ userId: 1, tenantId: 7, role: "admin" })
    mocks.getSaasMetrics.mockRejectedValue(new Error("db down"))
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBeTruthy()
  })
})
