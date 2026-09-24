import { describe, it, expect } from "vitest"
import {
  computeProgress,
  computeProgressRaw,
  healthFromProgress,
  weightedScore,
  computeKpi,
  rollup,
  rollupByScope,
} from "@/lib/goals-kpi/calc"
import type { KpiGoal } from "@/lib/goals-kpi/config"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function goal(partial: Partial<KpiGoal>): KpiGoal {
  return {
    id: 1,
    name: "KPI",
    description: null,
    scope: "individual",
    scope_ref_id: null,
    scope_ref_label: "Alice",
    unit: null,
    direction: "increase",
    target_value: 100,
    actual_value: 0,
    weight: 1,
    period_type: "monthly",
    period_start: null,
    period_end: null,
    lifecycle: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// computeProgress — direction semantics
// ---------------------------------------------------------------------------

describe("computeProgress — increase (higher is better)", () => {
  it("is the actual/target ratio as a percentage", () => {
    expect(computeProgress({ target: 100, actual: 50, direction: "increase" })).toBe(50)
    expect(computeProgress({ target: 200, actual: 50, direction: "increase" })).toBe(25)
  })

  it("clamps over-performance to 100 for display", () => {
    expect(computeProgress({ target: 100, actual: 150, direction: "increase" })).toBe(100)
  })

  it("keeps the unclamped value available via the raw helper", () => {
    expect(computeProgressRaw({ target: 100, actual: 150, direction: "increase" })).toBe(150)
  })

  it("treats a positive actual against a zero target as fully met", () => {
    expect(computeProgress({ target: 0, actual: 5, direction: "increase" })).toBe(100)
    expect(computeProgress({ target: 0, actual: 0, direction: "increase" })).toBe(0)
  })
})

describe("computeProgress — decrease (lower is better)", () => {
  it("is the target/actual ratio as a percentage", () => {
    expect(computeProgress({ target: 50, actual: 100, direction: "decrease" })).toBe(50)
    expect(computeProgress({ target: 100, actual: 200, direction: "decrease" })).toBe(50)
  })

  it("meeting or beating the ceiling clamps to 100", () => {
    expect(computeProgress({ target: 100, actual: 80, direction: "decrease" })).toBe(100)
    expect(computeProgress({ target: 100, actual: 0, direction: "decrease" })).toBe(100)
  })
})

describe("computeProgress — maintain (on target)", () => {
  it("is 100 when exactly on target", () => {
    expect(computeProgress({ target: 100, actual: 100, direction: "maintain" })).toBe(100)
  })

  it("falls off proportionally to the deviation", () => {
    expect(computeProgress({ target: 100, actual: 90, direction: "maintain" })).toBe(90)
    expect(computeProgress({ target: 100, actual: 110, direction: "maintain" })).toBe(90)
  })

  it("clamps a large deviation to 0", () => {
    expect(computeProgress({ target: 100, actual: 300, direction: "maintain" })).toBe(0)
  })
})

describe("computeProgress — invalid inputs", () => {
  it("returns 0 for non-finite values", () => {
    expect(computeProgress({ target: Number.NaN, actual: 10, direction: "increase" })).toBe(0)
    expect(computeProgress({ target: 100, actual: Number.POSITIVE_INFINITY, direction: "increase" })).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// healthFromProgress — banding
// ---------------------------------------------------------------------------

describe("healthFromProgress", () => {
  it("maps progress to the correct band at each boundary", () => {
    expect(healthFromProgress(100)).toBe("achieved")
    expect(healthFromProgress(120)).toBe("achieved")
    expect(healthFromProgress(99.99)).toBe("on_track")
    expect(healthFromProgress(70)).toBe("on_track")
    expect(healthFromProgress(69.99)).toBe("at_risk")
    expect(healthFromProgress(40)).toBe("at_risk")
    expect(healthFromProgress(39.99)).toBe("behind")
    expect(healthFromProgress(0)).toBe("behind")
  })
})

// ---------------------------------------------------------------------------
// weightedScore — roll-up scoring
// ---------------------------------------------------------------------------

describe("weightedScore", () => {
  it("weights each progress by its weight", () => {
    // (80*3 + 40*1) / (3+1) = 280/4 = 70
    expect(weightedScore([{ progress: 80, weight: 3 }, { progress: 40, weight: 1 }])).toBe(70)
  })

  it("ignores non-positive weights", () => {
    expect(weightedScore([{ progress: 80, weight: 2 }, { progress: 0, weight: 0 }, { progress: 100, weight: -5 }])).toBe(80)
  })

  it("returns 0 for an empty or zero-weight set", () => {
    expect(weightedScore([])).toBe(0)
    expect(weightedScore([{ progress: 90, weight: 0 }])).toBe(0)
  })

  it("clamps each contribution to [0,100] before weighting", () => {
    expect(weightedScore([{ progress: 150, weight: 1 }])).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// computeKpi — enrichment
// ---------------------------------------------------------------------------

describe("computeKpi", () => {
  it("attaches progress, health and weighted contribution", () => {
    const c = computeKpi(goal({ target_value: 100, actual_value: 75, weight: 2, direction: "increase" }))
    expect(c.progress).toBe(75)
    expect(c.health).toBe("on_track")
    expect(c.weightedContribution).toBe(150)
  })

  it("treats a negative weight as zero contribution", () => {
    const c = computeKpi(goal({ target_value: 100, actual_value: 100, weight: -1 }))
    expect(c.weightedContribution).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// rollup / rollupByScope — aggregation
// ---------------------------------------------------------------------------

describe("rollup", () => {
  it("aggregates count, average, weighted score, weight and health bands", () => {
    const items = [
      computeKpi(goal({ id: 1, target_value: 100, actual_value: 100, weight: 1 })), // 100 achieved
      computeKpi(goal({ id: 2, target_value: 100, actual_value: 50, weight: 3 })), // 50 at_risk
      computeKpi(goal({ id: 3, target_value: 100, actual_value: 20, weight: 1 })), // 20 behind
    ]
    const r = rollup(items)
    expect(r.count).toBe(3)
    expect(r.averageProgress).toBe(round2((100 + 50 + 20) / 3))
    // weighted: (100*1 + 50*3 + 20*1) / 5 = 270/5 = 54
    expect(r.weightedScore).toBe(54)
    expect(r.totalWeight).toBe(5)
    expect(r.byHealth).toEqual({ achieved: 1, on_track: 0, at_risk: 1, behind: 1 })
  })

  it("returns zeroed metrics for an empty set", () => {
    const r = rollup([])
    expect(r).toEqual({
      count: 0,
      averageProgress: 0,
      weightedScore: 0,
      totalWeight: 0,
      byHealth: { achieved: 0, on_track: 0, at_risk: 0, behind: 0 },
    })
  })
})

describe("rollupByScope", () => {
  it("groups computed KPIs by scope with a per-scope roll-up", () => {
    const items = [
      computeKpi(goal({ id: 1, scope: "individual", target_value: 100, actual_value: 100 })),
      computeKpi(goal({ id: 2, scope: "team", target_value: 100, actual_value: 40 })),
      computeKpi(goal({ id: 3, scope: "team", target_value: 100, actual_value: 80 })),
    ]
    const byScope = rollupByScope(items)
    expect(Object.keys(byScope).sort()).toEqual(["individual", "team"])
    expect(byScope.individual.count).toBe(1)
    expect(byScope.team.count).toBe(2)
    expect(byScope.team.averageProgress).toBe(60)
  })
})

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}
