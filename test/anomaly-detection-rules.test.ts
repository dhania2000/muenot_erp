import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * SPEC 20 (req #75) — explainable rules (noisy baselines, false positives,
 * duplicates), dedup signatures (tenant isolation), the human-only status
 * machine, and the request permission gate.
 */

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  currentTenantIdOrNull: vi.fn(),
  userHasFeature: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth", () => ({ getSession: auth.getSession }))
vi.mock("@/lib/tenant-scope", () => ({ currentTenantIdOrNull: auth.currentTenantIdOrNull }))
vi.mock("@/lib/permissions", () => ({ userHasFeature: auth.userHasFeature }))

import { detectAmountOutliers, detectDuplicateAmounts, detectSeriesSpike } from "@/lib/ai/anomaly-detection/detectors"
import { canTransitionStatus, deriveSignature } from "@/lib/ai/anomaly-detection/model"
import {
  requireAnomaly,
  isResponse,
  ANOMALY_MANAGE_FEATURE,
  ANOMALY_VIEW_FEATURE,
} from "@/lib/ai/anomaly-detection/request"

const rec = (id: string, amount: number, party = "Vendor") => ({ id, amount, party, occurredAt: "2027-01-10T00:00:00Z" })
const series = (values: number[]) =>
  values.map((value, i) => ({ bucket: `2027-01-${String(i + 1).padStart(2, "0")}`, value }))

describe("explainable rules", () => {
  it("does not flag ordinary variance in a noisy baseline", () => {
    const noisy = [80, 120, 95, 140, 60, 110, 130, 70, 105, 90, 125, 85].map((a, i) => rec(`p${i}`, a))
    expect(detectAmountOutliers("payment.amount_outlier", "payment", noisy)).toEqual([])
  })

  it("flags a genuine outlier with explainable evidence", () => {
    const records = [100, 102, 98, 101, 99, 103, 97, 100, 5000].map((a, i) => rec(`p${i}`, a))
    const findings = detectAmountOutliers("payment.amount_outlier", "payment", records)
    expect(findings).toHaveLength(1)
    expect(findings[0].entityId).toBe("p8")
    expect(findings[0].evidence).toBeTruthy()
  })

  it("never fires on too little history (false-positive guard)", () => {
    const records = [10, 10, 9000].map((a, i) => rec(`p${i}`, a))
    expect(detectAmountOutliers("payment.amount_outlier", "payment", records)).toEqual([])
  })

  it("ignores tiny absolute wobbles on a flat baseline", () => {
    const flat = series([0, 0, 0, 0, 0, 0, 0, 0, 1])
    expect(detectSeriesSpike("usage.metric_spike", "usage_meter", "api_calls", "api_calls", flat)).toEqual([])
  })

  it("flags a usage spike far above baseline", () => {
    const spiky = series([10, 12, 11, 9, 10, 11, 12, 10, 400])
    const findings = detectSeriesSpike("usage.metric_spike", "usage_meter", "api_calls", "api_calls", spiky)
    expect(findings.length).toBeGreaterThanOrEqual(1)
  })

  it("flags repeated identical amounts to one party as a duplicate signal", () => {
    const records = [rec("a", 250, "Acme"), rec("b", 250, "Acme"), rec("c", 250, "Acme"), rec("d", 90, "Beta")]
    const findings = detectDuplicateAmounts("payment", records)
    expect(findings).toHaveLength(1)
  })
})

describe("dedup signatures", () => {
  const base = { signal: "payment.amount_outlier" as const, entityType: "payment", entityId: "p8", occurredAt: "2027-01-10T08:00:00Z" }

  it("is stable across re-scans of the same day (idempotent alerts)", () => {
    expect(deriveSignature({ tenantId: 1, ...base })).toBe(
      deriveSignature({ tenantId: 1, ...base, occurredAt: "2027-01-10T22:00:00Z" }),
    )
  })

  it("differs across tenants so alerts can never collide cross-tenant", () => {
    expect(deriveSignature({ tenantId: 1, ...base })).not.toBe(deriveSignature({ tenantId: 2, ...base }))
  })
})

describe("human-only status machine", () => {
  it("allows triage paths and reopen", () => {
    expect(canTransitionStatus("open", "investigating")).toBe(true)
    expect(canTransitionStatus("resolved", "open")).toBe(true)
  })
  it("blocks jumping from a terminal state straight to confirmed", () => {
    expect(canTransitionStatus("dismissed", "confirmed")).toBe(false)
    expect(canTransitionStatus("resolved", "dismissed")).toBe(false)
  })
})

describe("requireAnomaly — permission gate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.getSession.mockResolvedValue({ userId: 5, role: "employee" })
    auth.currentTenantIdOrNull.mockReturnValue(7)
    auth.userHasFeature.mockResolvedValue(true)
  })

  it("401 without a session", async () => {
    auth.getSession.mockResolvedValue(null)
    const res = await requireAnomaly()
    expect(isResponse(res) && res.status).toBe(401)
  })

  it("400 without a tenant", async () => {
    auth.currentTenantIdOrNull.mockReturnValue(null)
    const res = await requireAnomaly()
    expect(isResponse(res) && res.status).toBe(400)
  })

  it("403 for a viewer attempting a manage action", async () => {
    auth.userHasFeature.mockImplementation(async (_u: number, _r: string, f: string) => f === ANOMALY_VIEW_FEATURE)
    const res = await requireAnomaly({ requireManage: true })
    expect(isResponse(res) && res.status).toBe(403)
    expect(auth.userHasFeature).toHaveBeenCalledWith(5, "employee", ANOMALY_MANAGE_FEATURE)
  })

  it("resolves the actor bound to the session tenant", async () => {
    const res = await requireAnomaly()
    expect(isResponse(res)).toBe(false)
    if (!isResponse(res)) {
      expect(res.tenantId).toBe(7)
      expect(res.actor).toEqual({ userId: 5, role: "employee", isAdmin: false })
    }
  })
})
