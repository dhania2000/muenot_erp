import { num, round2 } from "@/lib/finance-calc"

/**
 * SPEC 143 — Budget Management: the pure, side-effect-free budget math shared by
 * the config-driven Budget module (its `compute`), the Budget vs Actual report
 * engine and the unit tests. No database or server imports live here so it can
 * run in the browser bundle, on the server and under Vitest identically.
 */

/**
 * The economic nature of a budget line. It decides what "favorable" means:
 * spending less than an Expense/Capex budget is good, whereas earning less than
 * a Revenue target is bad. Variance is always stored as `budget - actual`, and
 * the nature only flips how that signed number is interpreted.
 */
export type BudgetNature = "Expense" | "Revenue" | "Capex"

export type BudgetVarianceStatus =
  | "No Activity"
  | "Under Budget"
  | "On Track"
  | "Warning"
  | "Over Budget"
  | "Below Target"
  | "Exceeded"

export type BudgetVariance = {
  budgeted: number
  actual: number
  nature: BudgetNature
  /** budget − actual. Positive = under budget (spent/earned less than planned). */
  variance: number
  /** |variance|, convenient for display. */
  absVariance: number
  /** variance ÷ budget × 100 (0 when there is no budget). */
  variancePercent: number
  /** actual ÷ budget × 100 (spend/earn progress against the plan). */
  utilizationPercent: number
  /** True when the outcome is good for this nature (under an expense / over a target). */
  favorable: boolean
  status: BudgetVarianceStatus
}

function normalizeNature(nature?: string | null): BudgetNature {
  const n = String(nature ?? "").trim().toLowerCase()
  if (n === "revenue" || n === "income") return "Revenue"
  if (n === "capex" || n === "capital") return "Capex"
  return "Expense"
}

/**
 * Core budget calculation. Given a budgeted amount, the actual amount and the
 * line's nature, derive the signed variance, the variance/utilisation percents,
 * whether the result is favorable and a human status band.
 *
 * Banding is utilisation-driven and deterministic:
 *  - Spending (Expense/Capex): ≤85% Under Budget, ≤100% On Track,
 *    ≤110% Warning, otherwise Over Budget.
 *  - Earning (Revenue): ≥110% Exceeded, ≥100% On Track, ≥90% Warning,
 *    otherwise Below Target.
 * A line with neither a budget nor an actual is "No Activity".
 */
export function computeBudgetVariance(
  budgetedInput: unknown,
  actualInput: unknown,
  natureInput?: string | null,
): BudgetVariance {
  const nature = normalizeNature(natureInput)
  const budgeted = round2(Math.max(0, num(budgetedInput)))
  const actual = round2(Math.max(0, num(actualInput)))
  const variance = round2(budgeted - actual)
  const variancePercent = budgeted > 0 ? round2((variance / budgeted) * 100) : 0
  const utilizationPercent = budgeted > 0 ? round2((actual / budgeted) * 100) : actual > 0 ? 100 : 0

  const spending = nature !== "Revenue"
  const favorable = spending ? actual <= budgeted : actual >= budgeted

  let status: BudgetVarianceStatus
  if (budgeted === 0 && actual === 0) {
    status = "No Activity"
  } else if (spending) {
    if (utilizationPercent <= 85) status = "Under Budget"
    else if (utilizationPercent <= 100) status = "On Track"
    else if (utilizationPercent <= 110) status = "Warning"
    else status = "Over Budget"
  } else {
    if (utilizationPercent >= 110) status = "Exceeded"
    else if (utilizationPercent >= 100) status = "On Track"
    else if (utilizationPercent >= 90) status = "Warning"
    else status = "Below Target"
  }

  return {
    budgeted,
    actual,
    nature,
    variance,
    absVariance: Math.abs(variance),
    variancePercent,
    utilizationPercent,
    favorable,
    status,
  }
}

/**
 * The persisted, read-only fields a Budget record derives from its budgeted and
 * actual amounts. Used by the module config's `compute` so the list, the detail
 * view and the stored row always agree with the report engine.
 */
export function deriveBudgetFields(v: Record<string, any>): {
  variance: number
  variance_percent: number
  utilization_percent: number
  variance_status: BudgetVarianceStatus
} {
  const r = computeBudgetVariance(v.budgeted_amount, v.actual_amount, v.budget_nature)
  return {
    variance: r.variance,
    variance_percent: r.variancePercent,
    utilization_percent: r.utilizationPercent,
    variance_status: r.status,
  }
}

export type BudgetRollupItem = {
  budgeted: unknown
  actual: unknown
  nature?: string | null
}

export type BudgetRollup = {
  count: number
  totalBudgeted: number
  totalActual: number
  /** Σ(budget − actual) across every line. */
  totalVariance: number
  utilizationPercent: number
  favorableCount: number
  unfavorableCount: number
  overBudgetCount: number
}

/**
 * Aggregate a set of budget lines into portfolio totals. Each line's variance
 * and favorability are computed with its own nature, then summed, so a mixed
 * set of expense and revenue lines rolls up correctly. `utilizationPercent` is
 * the blended actual÷budget across the whole set.
 */
export function rollUpBudgets(items: BudgetRollupItem[]): BudgetRollup {
  let totalBudgeted = 0
  let totalActual = 0
  let favorableCount = 0
  let unfavorableCount = 0
  let overBudgetCount = 0

  for (const item of items) {
    const r = computeBudgetVariance(item.budgeted, item.actual, item.nature)
    totalBudgeted = round2(totalBudgeted + r.budgeted)
    totalActual = round2(totalActual + r.actual)
    if (r.status === "No Activity") continue
    if (r.favorable) favorableCount += 1
    else unfavorableCount += 1
    if (r.status === "Over Budget") overBudgetCount += 1
  }

  return {
    count: items.length,
    totalBudgeted,
    totalActual,
    totalVariance: round2(totalBudgeted - totalActual),
    utilizationPercent: totalBudgeted > 0 ? round2((totalActual / totalBudgeted) * 100) : totalActual > 0 ? 100 : 0,
    favorableCount,
    unfavorableCount,
    overBudgetCount,
  }
}
