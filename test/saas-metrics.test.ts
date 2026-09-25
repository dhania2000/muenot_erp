import { describe, expect, it } from "vitest"
import {
  computeArr,
  computeChurn,
  computeMrr,
  groupRevenueByPlan,
  monthlyAmount,
  MRR_STATUSES,
  type SubForMetrics,
} from "@/lib/billing/saas-metrics"
import { round2 } from "@/lib/billing/billing-math"

/**
 * Spec6 (#240-241) — Pure, DB-free validation of the SaaS revenue metrics:
 * MRR/ARR normalization across billing terms, logo churn, and revenue-by-plan
 * that ALWAYS reconciles to the total invoiced (no dropped/double-counted
 * invoice).
 */

describe("monthlyAmount", () => {
  it("normalizes each term price to a monthly-recurring equivalent", () => {
    expect(monthlyAmount(100, "monthly")).toBe(100)
    expect(monthlyAmount(1200, "yearly")).toBe(100)
    expect(monthlyAmount(2400, "two_year")).toBe(100)
    expect(monthlyAmount(6000, "five_year")).toBe(100)
  })
})

describe("computeMrr / computeArr", () => {
  const subs: SubForMetrics[] = [
    { amount: 1200, term: "yearly", status: "active" }, // 100/mo
    { amount: 100, term: "monthly", status: "past_due" }, // 100/mo (still committed)
    { amount: 50, term: "monthly", status: "grace" }, // 50/mo
    { amount: 999, term: "monthly", status: "canceled" }, // excluded
    { amount: 999, term: "monthly", status: "trial" }, // excluded (not in MRR_STATUSES)
  ]

  it("sums monthly-equivalents of only revenue-bearing statuses", () => {
    expect(MRR_STATUSES.has("trial")).toBe(false)
    expect(computeMrr(subs)).toBe(250)
  })

  it("derives ARR as 12x MRR", () => {
    expect(computeArr(computeMrr(subs))).toBe(3000)
  })

  it("honors an explicit status set", () => {
    expect(computeMrr(subs, new Set(["active"]))).toBe(100)
  })
})

describe("computeChurn", () => {
  it("is churned / active-at-start as a percentage", () => {
    expect(computeChurn({ activeAtStart: 200, churnedDuring: 10 })).toBe(5)
  })
  it("is zero when there was no active base", () => {
    expect(computeChurn({ activeAtStart: 0, churnedDuring: 4 })).toBe(0)
  })
})

describe("groupRevenueByPlan (reconciles to invoices)", () => {
  it("buckets by plan, sorts by revenue and re-sums to the invoiced total", () => {
    const invoices = [
      { plan_name: "Pro", total: 100 },
      { plan_name: "Pro", total: 50.5 },
      { plan_name: "Starter", total: 20 },
      { plan_name: null, total: 9.99 }, // -> "Unassigned"
    ]
    const { plans, invoicedTotal } = groupRevenueByPlan(invoices)
    expect(plans[0]).toEqual({ plan_name: "Pro", invoiced: 150.5, invoices: 2 })
    expect(plans.find((p) => p.plan_name === "Unassigned")?.invoiced).toBe(9.99)
    // Reconciliation invariant: per-plan buckets sum to the whole set.
    const rawTotal = round2(invoices.reduce((s, i) => s + i.total, 0))
    expect(invoicedTotal).toBe(rawTotal)
    expect(round2(plans.reduce((s, p) => s + p.invoiced, 0))).toBe(invoicedTotal)
  })

  it("reconciles even with credit notes (negative totals) in the set", () => {
    const invoices = [
      { plan_name: "Pro", total: 100 },
      { plan_name: "Pro", total: -100 }, // credit note reverses it
    ]
    const { plans, invoicedTotal } = groupRevenueByPlan(invoices)
    expect(invoicedTotal).toBe(0)
    expect(plans[0].invoiced).toBe(0)
    expect(plans[0].invoices).toBe(2)
  })
})
