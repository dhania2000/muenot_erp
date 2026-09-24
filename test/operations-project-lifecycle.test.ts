import { describe, expect, it } from "vitest"
import { computeRiskScoring, computeSlaTracking } from "@/lib/operations-sync"

/**
 * SPEC 146 — Phase 4. Pure, DB-free validation of the derived values that drive
 * a project's lifecycle: risk-register scoring (probability × impact) and SLA
 * status tracking. These derivations are enforced server-side on every
 * create/update, so the buckets they produce must stay exact.
 */

describe("computeRiskScoring", () => {
  it("multiplies probability × impact on a 1/2/3 scale", () => {
    expect(computeRiskScoring({ probability: "High", impact: "High" })).toEqual({
      risk_score: 9,
      risk_level: "Critical",
    })
    expect(computeRiskScoring({ probability: "Low", impact: "Low" })).toEqual({
      risk_score: 1,
      risk_level: "Low",
    })
  })

  it("buckets the score into Low/Medium/High/Critical bands", () => {
    // 1 → Low, 2 → Medium, 4 → High, 6 → Critical
    expect(computeRiskScoring({ probability: "Low", impact: "Medium" }).risk_level).toBe("Medium")
    expect(computeRiskScoring({ probability: "Medium", impact: "Medium" }).risk_level).toBe("High")
    expect(computeRiskScoring({ probability: "Medium", impact: "High" }).risk_level).toBe("Critical")
  })

  it("is case-insensitive and tolerant of surrounding whitespace", () => {
    expect(computeRiskScoring({ probability: "  hIgH ", impact: "medium" })).toEqual({
      risk_score: 6,
      risk_level: "Critical",
    })
  })

  it("returns an empty patch when probability or impact is missing or invalid", () => {
    expect(computeRiskScoring({ probability: "High" })).toEqual({})
    expect(computeRiskScoring({ probability: "", impact: "" })).toEqual({})
    expect(computeRiskScoring({ probability: "Severe", impact: "High" })).toEqual({})
  })
})

describe("computeSlaTracking", () => {
  it("flags a breach when work completed after the due date", () => {
    const result = computeSlaTracking({ due_date: "2026-01-10", actual_completion: "2026-01-15" })
    expect(result.delay_days).toBe(5)
    expect(result.sla_status).toBe("Breached SLA")
  })

  it("meets the SLA when completed on or before the due date", () => {
    const result = computeSlaTracking({ due_date: "2026-01-10", actual_completion: "2026-01-08" })
    expect(result.delay_days).toBe(-2)
    expect(result.sla_status).toBe("Met SLA")
  })

  it("marks an open item past its due date as breached", () => {
    const result = computeSlaTracking({ due_date: "2000-01-01" })
    expect(result.delay_days).toBeGreaterThan(0)
    expect(result.sla_status).toBe("Breached SLA")
  })

  it("marks an open item within two days of its due date as at risk", () => {
    const today = new Date()
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000)
    const result = computeSlaTracking({ due_date: tomorrow.toISOString().slice(0, 10) })
    expect(result.sla_status).toBe("At Risk")
  })

  it("returns an empty patch when the due date is missing or invalid", () => {
    expect(computeSlaTracking({})).toEqual({})
    expect(computeSlaTracking({ due_date: "not-a-date" })).toEqual({})
  })
})
