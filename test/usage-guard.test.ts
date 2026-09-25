import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec 5 — wiring layer between the metering core and real backend send paths.
 *
 * `usage-guard` is the thin adapter every choke point (storage, WhatsApp, SMS,
 * voice, the public API pipeline, automation) calls. These tests prove the two
 * guarantees the send paths depend on, WITHOUT a database:
 *
 *   1. Tenant scoping — an event/enforcement is only recorded for a bound tenant
 *      OR an explicitly supplied one; with neither it is a silent no-op instead
 *      of leaking into another tenant or throwing on a system entry point.
 *   2. Fail-closed enforcement — a hard limit surfaces as a `UsageLimitError`
 *      the caller maps to 402, while a soft/absent limit passes the check
 *      through so the caller can warn.
 */

// Capture what the metering primitives are asked to do, keeping MySQL out.
const recordUsageMock = vi.fn(async () => true)
const recordUsageSafeMock = vi.fn(() => {})
const enforceMock = vi.fn(async (_meterKey: string, _amount = 1) => ({
  allowed: true,
  used: 1,
  limit: 100,
  remaining: 99,
  hardLimit: false,
  status: "ok" as const,
}))

// Defined via vi.hoisted so the hoisted vi.mock factory below can reference it.
const { FakeUsageLimitError } = vi.hoisted(() => {
  class FakeUsageLimitError extends Error {
    readonly check: unknown
    readonly meterKey: string
    constructor(meterKey: string, check: unknown) {
      super(`limit reached for ${meterKey}`)
      this.name = "UsageLimitError"
      this.meterKey = meterKey
      this.check = check
    }
  }
  return { FakeUsageLimitError }
})

vi.mock("@/lib/billing/usage-metering", () => ({
  recordUsage: (input: any) => recordUsageMock(input),
  recordUsageSafe: (input: any) => recordUsageSafeMock(input),
  enforceUsageLimit: (meterKey: string, amount = 1) => enforceMock(meterKey, amount),
  UsageLimitError: FakeUsageLimitError,
}))

// Bindable tenant context: `runForTenant` runs its callback under an explicit
// tenant; `currentTenantIdOrNull` reflects whatever is currently bound.
let boundTenant: number | null = null
vi.mock("@/lib/tenant-scope", () => ({
  currentTenantIdOrNull: () => boundTenant,
  runForTenant: async (opts: { tenantId: number }, fn: () => any) => {
    const prev = boundTenant
    boundTenant = opts.tenantId
    try {
      return await fn()
    } finally {
      boundTenant = prev
    }
  },
}))

import { enforceUsageIfScoped, meterUsage, UsageLimitError } from "@/lib/billing/usage-guard"

beforeEach(() => {
  boundTenant = null
  recordUsageMock.mockClear()
  recordUsageSafeMock.mockClear()
  enforceMock.mockClear()
  enforceMock.mockResolvedValue({
    allowed: true,
    used: 1,
    limit: 100,
    remaining: 99,
    hardLimit: false,
    status: "ok",
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// meterUsage — tenant scoping
// ---------------------------------------------------------------------------

describe("meterUsage", () => {
  it("records under the current bound tenant via the safe path", () => {
    boundTenant = 7
    meterUsage({ meterKey: "api_requests", quantity: 1, idempotencyKey: "api:req_1" })
    expect(recordUsageSafeMock).toHaveBeenCalledTimes(1)
    expect(recordUsageMock).not.toHaveBeenCalled()
  })

  it("is a silent no-op when no tenant is bound and none is supplied", () => {
    meterUsage({ meterKey: "api_requests", quantity: 1 })
    expect(recordUsageSafeMock).not.toHaveBeenCalled()
    expect(recordUsageMock).not.toHaveBeenCalled()
  })

  it("records under an explicit tenant from a system entry point (no session)", async () => {
    meterUsage({ meterKey: "automation_runs", quantity: 1, tenantId: 42, idempotencyKey: "wf:1" })
    // runForTenant resolves asynchronously; flush the microtask queue.
    await Promise.resolve()
    await Promise.resolve()
    expect(recordUsageMock).toHaveBeenCalledTimes(1)
    // The tenantId must NOT be forwarded as a meter field — it only binds scope.
    expect(recordUsageMock.mock.calls[0][0]).not.toHaveProperty("tenantId")
    expect(recordUsageMock.mock.calls[0][0]).toMatchObject({ meterKey: "automation_runs", idempotencyKey: "wf:1" })
  })
})

// ---------------------------------------------------------------------------
// enforceUsageIfScoped — fail-closed hard limits
// ---------------------------------------------------------------------------

describe("enforceUsageIfScoped", () => {
  it("returns null (skips enforcement) when unscoped and no tenant supplied", async () => {
    const res = await enforceUsageIfScoped("whatsapp_messages", 1)
    expect(res).toBeNull()
    expect(enforceMock).not.toHaveBeenCalled()
  })

  it("enforces for the bound tenant and passes a soft/ok check through", async () => {
    boundTenant = 7
    const res = await enforceUsageIfScoped("whatsapp_messages", 1)
    expect(enforceMock).toHaveBeenCalledWith("whatsapp_messages", 1)
    expect(res?.status).toBe("ok")
  })

  it("enforces under an explicit tenant for a system entry point", async () => {
    const res = await enforceUsageIfScoped("api_requests", 1, 42)
    expect(enforceMock).toHaveBeenCalledWith("api_requests", 1)
    expect(res?.allowed).toBe(true)
  })

  it("propagates a hard-limit UsageLimitError so the caller can return 402", async () => {
    boundTenant = 7
    enforceMock.mockRejectedValueOnce(
      new FakeUsageLimitError("whatsapp_messages", { allowed: false, hardLimit: true }),
    )
    await expect(enforceUsageIfScoped("whatsapp_messages", 1)).rejects.toBeInstanceOf(UsageLimitError)
  })
})
