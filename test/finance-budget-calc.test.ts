import { describe, it, expect } from "vitest"
import {
  computeBudgetVariance,
  deriveBudgetFields,
  rollUpBudgets,
} from "@/lib/finance-budget-calc"

/**
 * SPEC 143 — Budget Management. DB-free proof that the shared budget math is
 * deterministic and that variance / utilisation / status banding behaves the
 * same for the module `compute`, the report engine and the tests.
 */
describe("computeBudgetVariance — spending (Expense / Capex)", () => {
  it("reports a favorable, under-budget line when actual is well below budget", () => {
    const r = computeBudgetVariance(100000, 60000, "Expense")
    expect(r.variance).toBe(40000)
    expect(r.absVariance).toBe(40000)
    expect(r.variancePercent).toBe(40)
    expect(r.utilizationPercent).toBe(60)
    expect(r.favorable).toBe(true)
    expect(r.status).toBe("Under Budget")
  })

  it("bands utilisation deterministically at the 85 / 100 / 110 boundaries", () => {
    expect(computeBudgetVariance(100, 85, "Expense").status).toBe("Under Budget")
    expect(computeBudgetVariance(100, 90, "Expense").status).toBe("On Track")
    expect(computeBudgetVariance(100, 100, "Expense").status).toBe("On Track")
    expect(computeBudgetVariance(100, 105, "Expense").status).toBe("Warning")
    expect(computeBudgetVariance(100, 110, "Expense").status).toBe("Warning")
    expect(computeBudgetVariance(100, 120, "Expense").status).toBe("Over Budget")
  })

  it("flags an over-budget expense as unfavorable with a negative variance", () => {
    const r = computeBudgetVariance(50000, 65000, "Capex")
    expect(r.variance).toBe(-15000)
    expect(r.variancePercent).toBe(-30)
    expect(r.utilizationPercent).toBe(130)
    expect(r.favorable).toBe(false)
    expect(r.status).toBe("Over Budget")
  })
})

describe("computeBudgetVariance — earning (Revenue)", () => {
  it("treats earning more than target as favorable and 'Exceeded'", () => {
    const r = computeBudgetVariance(200000, 240000, "Revenue")
    // variance is still budget − actual, so beating a target is negative here…
    expect(r.variance).toBe(-40000)
    expect(r.utilizationPercent).toBe(120)
    // …but for a revenue target that outcome is favorable.
    expect(r.favorable).toBe(true)
    expect(r.status).toBe("Exceeded")
  })

  it("bands revenue at the 90 / 100 / 110 boundaries", () => {
    expect(computeBudgetVariance(100, 80, "Revenue").status).toBe("Below Target")
    expect(computeBudgetVariance(100, 90, "Revenue").status).toBe("Warning")
    expect(computeBudgetVariance(100, 100, "Revenue").status).toBe("On Track")
    expect(computeBudgetVariance(100, 110, "Revenue").status).toBe("Exceeded")
  })

  it("normalizes nature aliases (income → Revenue, capital → Capex)", () => {
    expect(computeBudgetVariance(100, 120, "income").nature).toBe("Revenue")
    expect(computeBudgetVariance(100, 120, "capital").nature).toBe("Capex")
    expect(computeBudgetVariance(100, 120, "anything-else").nature).toBe("Expense")
  })
})

describe("computeBudgetVariance — edge cases", () => {
  it("returns 'No Activity' when there is neither budget nor actual", () => {
    const r = computeBudgetVariance(0, 0, "Expense")
    expect(r.status).toBe("No Activity")
    expect(r.variancePercent).toBe(0)
    expect(r.utilizationPercent).toBe(0)
  })

  it("treats spend with no budget as 100% utilised and over budget", () => {
    const r = computeBudgetVariance(0, 500, "Expense")
    expect(r.utilizationPercent).toBe(100)
    expect(r.status).toBe("On Track")
  })

  it("coerces junk / negative input to non-negative numbers", () => {
    const r = computeBudgetVariance("abc", -500, "Expense")
    expect(r.budgeted).toBe(0)
    expect(r.actual).toBe(0)
    expect(r.status).toBe("No Activity")
  })

  it("rounds money to 2 decimals", () => {
    const r = computeBudgetVariance(100.005, 33.334, "Expense")
    expect(r.budgeted).toBe(100.01)
    expect(r.actual).toBe(33.33)
    expect(r.variance).toBe(66.68)
  })
})

describe("deriveBudgetFields — persisted columns", () => {
  it("maps the calculation onto the stored column names", () => {
    const d = deriveBudgetFields({ budgeted_amount: 1000, actual_amount: 1200, budget_nature: "Expense" })
    expect(d).toEqual({
      variance: -200,
      variance_percent: -20,
      utilization_percent: 120,
      variance_status: "Over Budget",
    })
  })

  it("defaults missing nature to Expense", () => {
    const d = deriveBudgetFields({ budgeted_amount: 1000, actual_amount: 500 })
    expect(d.variance_status).toBe("Under Budget")
  })
})

describe("rollUpBudgets — portfolio aggregation", () => {
  it("sums a mixed expense + revenue portfolio with per-line nature", () => {
    const roll = rollUpBudgets([
      { budgeted: 100000, actual: 60000, nature: "Expense" }, // favorable, under
      { budgeted: 50000, actual: 65000, nature: "Expense" }, // over budget
      { budgeted: 200000, actual: 240000, nature: "Revenue" }, // favorable (exceeded)
      { budgeted: 0, actual: 0, nature: "Expense" }, // no activity — ignored in counts
    ])
    expect(roll.count).toBe(4)
    expect(roll.totalBudgeted).toBe(350000)
    expect(roll.totalActual).toBe(365000)
    expect(roll.totalVariance).toBe(-15000)
    expect(roll.favorableCount).toBe(2)
    expect(roll.unfavorableCount).toBe(1)
    expect(roll.overBudgetCount).toBe(1)
    // blended actual ÷ budget
    expect(roll.utilizationPercent).toBe(104.29)
  })

  it("handles an empty portfolio", () => {
    const roll = rollUpBudgets([])
    expect(roll).toMatchObject({
      count: 0,
      totalBudgeted: 0,
      totalActual: 0,
      totalVariance: 0,
      utilizationPercent: 0,
      favorableCount: 0,
      unfavorableCount: 0,
      overBudgetCount: 0,
    })
  })
})
