import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  PLAN_REQUIRED_CODE,
  evaluatePlanGate,
  planAllowsModule,
  requiredFeatureForPath,
} from "@/lib/billing/plan-gate-model"
import { ENTITLEMENT_PRESETS, normalizeEntitlements } from "@/lib/platform/entitlements"

vi.mock("@/lib/maintenance/gate-token", () => ({
  BILLING_GATE_HEADER: "x-billing-gate",
  billingWriteLockToken: vi.fn(async () => "tok"),
}))

const hrOnly = normalizeEntitlements({ modules: ["hr"] })

describe("plan-gate model", () => {
  it("maps API paths to module core features", () => {
    expect(requiredFeatureForPath("/api/hr/employees")).toBe("hr.core")
    expect(requiredFeatureForPath("/api/recruitment/jobs")).toBe("hr.core")
    expect(requiredFeatureForPath("/api/finance/invoices")).toBe("finance.core")
    expect(requiredFeatureForPath("/api/sales/leads")).toBe("crm.pipeline")
    expect(requiredFeatureForPath("/api/billing/portal")).toBeNull()
    expect(requiredFeatureForPath("/finance")).toBeNull()
    expect(requiredFeatureForPath("/api/financex")).toBeNull()
  })

  it("denies a module outside the plan with PLAN_REQUIRED", () => {
    const denial = evaluatePlanGate("/api/finance/invoices", hrOnly)
    expect(denial?.code).toBe(PLAN_REQUIRED_CODE)
    expect(denial?.feature).toBe("finance.core")
    expect(evaluatePlanGate("/api/hr/employees", hrOnly)).toBeNull()
  })

  it("never gates unsubscribed tenants or platform staff", () => {
    expect(evaluatePlanGate("/api/finance/invoices", null)).toBeNull()
    expect(evaluatePlanGate("/api/finance/invoices", hrOnly, "super_admin")).toBeNull()
    expect(planAllowsModule(null, "finance")).toBe(true)
  })

  it("does not strip modules any shipped preset already grants", () => {
    for (const [name, preset] of Object.entries(ENTITLEMENT_PRESETS)) {
      for (const mod of preset.modules) {
        const path = { hr: "/api/hr/x", finance: "/api/finance/x", crm: "/api/sales/x", inventory: "/api/products/x", projects: "/api/operations/x" }[mod as string]
        if (path) expect(evaluatePlanGate(path, preset), `${name}:${mod}`).toBeNull()
      }
    }
  })
})

describe("billingPlanGate (edge)", () => {
  beforeEach(async () => {
    const mod = await import("@/lib/billing/edge-write-lock")
    mod.__resetWriteLockCache()
    process.env.SESSION_SECRET = "s"
  })

  const feed = (plan: unknown) =>
    vi.fn(async (_url: string) => new Response(JSON.stringify({ writable: true, status: "active", plan }), { status: 200 }))

  it("returns 403 for an out-of-plan module and scopes the lookup to the session tenant", async () => {
    const { billingPlanGate } = await import("@/lib/billing/edge-write-lock")
    const f = feed(hrOnly)
    const res = await billingPlanGate(new NextRequest("http://x.test/api/finance/invoices?tenantId=999"), { tenantId: 7 }, "r1", f as unknown as typeof fetch)
    expect(res?.status).toBe(403)
    expect((await res!.json()).code).toBe(PLAN_REQUIRED_CODE)
    expect(String(f.mock.calls[0][0])).toContain("tenantId=7")
  })

  it("allows in-plan modules, reads too, and skips ungated paths without a lookup", async () => {
    const { billingPlanGate } = await import("@/lib/billing/edge-write-lock")
    const f = feed(hrOnly)
    expect(await billingPlanGate(new NextRequest("http://x.test/api/hr/employees"), { tenantId: 7 }, "r", f as unknown as typeof fetch)).toBeNull()
    const g = feed(hrOnly)
    expect(await billingPlanGate(new NextRequest("http://x.test/api/billing/portal"), { tenantId: 7 }, "r", g as unknown as typeof fetch)).toBeNull()
    expect(g).not.toHaveBeenCalled()
  })

  it("fails open when the feed is unavailable", async () => {
    const { billingPlanGate } = await import("@/lib/billing/edge-write-lock")
    const down = vi.fn(async () => { throw new Error("down") })
    expect(await billingPlanGate(new NextRequest("http://x.test/api/finance/invoices"), { tenantId: 7 }, "r", down as unknown as typeof fetch)).toBeNull()
  })
})
