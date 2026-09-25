import { describe, expect, it } from "vitest"
import {
  CustomerSuccessError,
  MAX_EVENTS_PER_BATCH,
  actorHash,
  computeHealth,
  computeTrend,
  dedupKey,
  escapeLike,
  normalizeEvent,
  normalizeEventBatch,
  parseTenantHealthFilter,
  validateSettingsPatch,
  type HealthSignals,
} from "@/lib/customer-success/model"

const now = new Date("2026-09-26T12:00:30Z")

const healthy: HealthSignals = {
  adoption: { available: true, activeUsers30d: 10, seats: 10, modulesUsed30d: 6, events30d: 500, eventsPrev30d: 450 },
  errors: { errors7d: 0, critical7d: 0 },
  jobs: { total7d: 20, failed7d: 0 },
  billing: { status: "active", overdueInvoices: 0 },
  support: { open: 0, urgentOpen: 0, breached30d: 0 },
}

describe("usage event validation (privacy allowlist)", () => {
  it("keeps only allowlisted fields and drops personal content", () => {
    const e = normalizeEvent({ module: "Sales", feature: "leads.list", action: "VIEW", email: "a@b.c", note: "secret", payload: { x: 1 } }, now)
    expect(e).toEqual({ module: "sales", feature: "leads.list", action: "view", clientEventId: null, occurredAt: now })
    expect(JSON.stringify(e)).not.toContain("a@b.c")
    expect(JSON.stringify(e)).not.toContain("secret")
  })
  it("rejects free text in module/feature and unknown actions", () => {
    expect(() => normalizeEvent({ module: "john smith", feature: "x1" }, now)).toThrow(CustomerSuccessError)
    expect(() => normalizeEvent({ module: "sales", feature: "Invoice for ACME Ltd" }, now)).toThrow(/feature/)
    expect(() => normalizeEvent({ module: "sales", feature: "leads", action: "hack" }, now)).toThrow(/action/)
  })
  it("rejects stale or future timestamps and bad client ids", () => {
    expect(() => normalizeEvent({ module: "sales", feature: "leads", occurredAt: "2026-09-24T00:00:00Z" }, now)).toThrow(/24 hours/)
    expect(() => normalizeEvent({ module: "sales", feature: "leads", occurredAt: "2026-09-26T13:00:00Z" }, now)).toThrow()
    expect(() => normalizeEvent({ module: "sales", feature: "leads", clientEventId: "short" }, now)).toThrow(/clientEventId/)
  })
  it("enforces batch shape and size", () => {
    expect(() => normalizeEventBatch({ events: [] }, now)).toThrow(/non-empty/)
    expect(() => normalizeEventBatch({}, now)).toThrow()
    const many = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => ({ module: "sales", feature: "leads" }))
    expect(() => normalizeEventBatch({ events: many }, now)).toThrow(/At most/)
  })
})

describe("event deduplication keys", () => {
  const actor = actorHash("secret", 1, 5)
  it("actor hash is pseudonymous, tenant-salted and requires a secret", () => {
    expect(actor).toMatch(/^[a-f0-9]{32}$/)
    expect(actor).not.toContain("5")
    expect(actorHash("secret", 2, 5)).not.toBe(actor)
    expect(() => actorHash("", 1, 5)).toThrow(/not configured/)
  })
  it("collapses identical events in the same minute, separates different minutes", () => {
    const a = normalizeEvent({ module: "sales", feature: "leads", occurredAt: "2026-09-26T12:00:05Z" }, now)
    const b = normalizeEvent({ module: "sales", feature: "leads", occurredAt: "2026-09-26T12:00:55Z" }, now)
    const c = normalizeEvent({ module: "sales", feature: "leads", occurredAt: "2026-09-26T11:59:59Z" }, now)
    expect(dedupKey(1, actor, a)).toBe(dedupKey(1, actor, b))
    expect(dedupKey(1, actor, a)).not.toBe(dedupKey(1, actor, c))
  })
  it("clientEventId retries collapse regardless of time; keys differ across tenants", () => {
    const a = normalizeEvent({ module: "sales", feature: "leads", clientEventId: "evt-12345678", occurredAt: "2026-09-26T11:00:00Z" }, now)
    const b = normalizeEvent({ module: "sales", feature: "leads", clientEventId: "evt-12345678" }, now)
    expect(dedupKey(1, actor, a)).toBe(dedupKey(1, actor, b))
    expect(dedupKey(2, actor, a)).not.toBe(dedupKey(1, actor, a))
  })
})

describe("health score explainability", () => {
  it("healthy tenant scores high with no risks and contributions summing to the score", () => {
    const r = computeHealth(healthy)
    expect(r.score).toBe(100)
    expect(r.band).toBe("healthy")
    expect(r.risks).toEqual([])
    expect(r.factors.map((f) => f.key)).toEqual(["adoption", "errors", "jobs", "billing", "support"])
    expect(r.factors.reduce((s, f) => s + f.effectiveWeight, 0)).toBeCloseTo(100, 0)
  })
  it("every factor carries human-readable reasons and contributions add up to the score", () => {
    const r = computeHealth({
      ...healthy,
      adoption: { ...healthy.adoption, activeUsers30d: 2, seats: 10, modulesUsed30d: 1, events30d: 10, eventsPrev30d: 100 },
      errors: { errors7d: 5, critical7d: 1 },
      jobs: { total7d: 10, failed7d: 4 },
      billing: { status: "past_due", overdueInvoices: 1 },
      support: { open: 2, urgentOpen: 1, breached30d: 3 },
    })
    const sum = r.factors.reduce((s, f) => s + f.contribution, 0)
    expect(Math.abs(sum - r.score)).toBeLessThanOrEqual(1)
    for (const f of r.factors) expect(f.reasons.length).toBeGreaterThan(0)
    expect(r.band).toBe("at_risk")
    expect(r.risks.map((x) => x.key).sort()).toEqual(
      ["billing_past_due", "critical_errors", "job_failures", "low_seat_activation", "overdue_invoices", "sla_breaches", "usage_decline"].sort(),
    )
    expect(r.risks.find((x) => x.key === "usage_decline")?.severity).toBe("high")
  })
  it("opt-out excludes adoption and rebalances weights instead of penalising", () => {
    const r = computeHealth({ ...healthy, adoption: { ...healthy.adoption, available: false } })
    const adoption = r.factors.find((f) => f.key === "adoption")!
    expect(adoption.available).toBe(false)
    expect(adoption.effectiveWeight).toBe(0)
    expect(r.score).toBe(100)
    expect(r.risks.some((x) => x.factor === "adoption")).toBe(false)
  })
  it("risk messages never include personal content", () => {
    const r = computeHealth({ ...healthy, billing: { status: "canceled", overdueInvoices: 2 } })
    for (const risk of r.risks) expect(risk.message).not.toMatch(/@/)
  })
})

describe("trend, settings and filters", () => {
  it("computes trend direction from sorted points", () => {
    expect(computeTrend([{ date: "2026-09-02", score: 60 }, { date: "2026-09-01", score: 80 }])).toMatchObject({ direction: "down", delta: -20 })
    expect(computeTrend([{ date: "2026-09-01", score: 60 }, { date: "2026-09-02", score: 61 }]).direction).toBe("flat")
    expect(computeTrend([]).direction).toBe("flat")
  })
  it("validates opt-out and retention settings", () => {
    expect(validateSettingsPatch({ analyticsOptOut: true })).toEqual({ analyticsOptOut: true })
    expect(validateSettingsPatch({ retentionDays: 90, other: "ignored" })).toEqual({ retentionDays: 90 })
    expect(() => validateSettingsPatch({ analyticsOptOut: "yes" })).toThrow()
    expect(() => validateSettingsPatch({ retentionDays: 7 })).toThrow()
    expect(() => validateSettingsPatch({ retentionDays: 10.5 })).toThrow()
    expect(() => validateSettingsPatch({})).toThrow(/No supported/)
  })
  it("parses and validates platform filters", () => {
    expect(parseTenantHealthFilter(new URLSearchParams("band=at_risk&risk=1&q=acme"))).toMatchObject({ band: "at_risk", atRiskOnly: true, q: "acme", page: 1 })
    expect(() => parseTenantHealthFilter(new URLSearchParams("band=bad"))).toThrow()
    expect(() => parseTenantHealthFilter(new URLSearchParams("pageSize=1000"))).toThrow()
    expect(() => parseTenantHealthFilter(new URLSearchParams("plan=a'b"))).toThrow()
    expect(escapeLike("50%_\\")).toBe("50\\%\\_\\\\")
  })
})
