import { describe, it, expect, vi } from "vitest"

// company-subscriptions.ts is `server-only` and imports the DB pool. We never
// call a query() path here — only the pure exports — but stub server-only so the
// module can be imported under Vitest.
vi.mock("server-only", () => ({}))

import {
  BILLING_CYCLES,
  SUBSCRIPTION_STATUSES,
  advanceByCycle,
  monthlyCost,
  annualCost,
  effectiveStatus,
  computeRenewalTerms,
  SubscriptionError,
} from "@/lib/company-subscriptions"

/**
 * Spec61 (#234-239) — company software subscription pure logic: billing-cycle
 * date math, cost normalization, derived status and renewal-term validation
 * (including failure paths). DB-free.
 */

describe("company-subscriptions — advanceByCycle", () => {
  it("advances by the correct number of months per cycle", () => {
    expect(advanceByCycle("2026-01-15", "Monthly")).toBe("2026-02-15")
    expect(advanceByCycle("2026-01-15", "Quarterly")).toBe("2026-04-15")
    expect(advanceByCycle("2026-01-15", "Half-Yearly")).toBe("2026-07-15")
    expect(advanceByCycle("2026-01-15", "Annual")).toBe("2027-01-15")
  })
  it("leaves a One-Time cycle unchanged", () => {
    expect(advanceByCycle("2026-01-15", "One-Time")).toBe("2026-01-15")
  })
  it("only supports the declared billing cycles", () => {
    expect(BILLING_CYCLES).toEqual(["Monthly", "Quarterly", "Half-Yearly", "Annual", "One-Time"])
  })
})

describe("company-subscriptions — cost normalization", () => {
  it("normalizes each cycle to a monthly figure", () => {
    expect(monthlyCost(120, "Monthly")).toBe(120)
    expect(monthlyCost(120, "Quarterly")).toBe(40)
    expect(monthlyCost(120, "Half-Yearly")).toBe(20)
    expect(monthlyCost(120, "Annual")).toBe(10)
    expect(monthlyCost(120, "One-Time")).toBe(0)
  })
  it("annualizes as 12x the monthly figure", () => {
    expect(annualCost(120, "Annual")).toBe(120)
    expect(annualCost(40, "Quarterly")).toBe(160)
    expect(annualCost(500, "One-Time")).toBe(0)
  })
})

describe("company-subscriptions — effectiveStatus", () => {
  it("returns terminal statuses as-is", () => {
    expect(effectiveStatus({ status: "Cancelled", end_date: "2020-01-01" }).status).toBe("Cancelled")
    expect(effectiveStatus({ status: "Suspended", end_date: "2020-01-01" }).status).toBe("Suspended")
  })
  it("derives Expired from a past end date", () => {
    const r = effectiveStatus({ status: "Active", end_date: "2000-01-01" })
    expect(r.status).toBe("Expired")
    expect(r.expiring_soon).toBe(false)
    expect(r.days_to_expiry).toBeLessThan(0)
  })
  it("flags expiring_soon within the reminder window", () => {
    const soon = new Date()
    soon.setDate(soon.getDate() + 5)
    const iso = soon.toISOString().slice(0, 10)
    const r = effectiveStatus({ status: "Active", end_date: iso, reminder_days: 30 })
    expect(r.status).toBe("Active")
    expect(r.expiring_soon).toBe(true)
  })
  it("returns nulls when there is no end date", () => {
    const r = effectiveStatus({ status: "Active" })
    expect(r.days_to_expiry).toBeNull()
    expect(r.expiring_soon).toBe(false)
  })
})

describe("company-subscriptions — computeRenewalTerms", () => {
  const base = {
    status: "Active",
    end_date: "2999-01-01",
    billing_cycle: "Annual" as const,
    amount: 1000,
  }

  it("advances the end date by one cycle when none is supplied", () => {
    const r = computeRenewalTerms(base, {})
    expect(r.newEnd).toBe("3000-01-01")
    expect(r.amount).toBe(1000)
    expect(r.previousEnd).toBe("2999-01-01")
  })

  it("honors an explicit new end date and amount", () => {
    const r = computeRenewalTerms(base, { new_end_date: "2999-06-30", amount: "1500.5" })
    expect(r.newEnd).toBe("2999-06-30")
    expect(r.amount).toBe(1500.5)
  })

  it("refuses to renew a cancelled subscription", () => {
    expect(() => computeRenewalTerms({ ...base, status: "Cancelled" }, {})).toThrow(SubscriptionError)
  })

  it("rejects an invalid or backwards end date", () => {
    expect(() => computeRenewalTerms(base, { new_end_date: "not-a-date" })).toThrow(/New end date is invalid/i)
    expect(() => computeRenewalTerms(base, { new_end_date: "2998-01-01" })).toThrow(/cannot be earlier/i)
  })

  it("rejects a negative or oversized renewal amount", () => {
    expect(() => computeRenewalTerms(base, { amount: -5 })).toThrow(/Renewal amount/i)
    expect(() => computeRenewalTerms(base, { amount: 2_000_000_000 })).toThrow(/Renewal amount/i)
  })

  it("requires an explicit end date for a one-time subscription with no prior end", () => {
    expect(() =>
      computeRenewalTerms({ status: "Active", end_date: null, billing_cycle: "One-Time", amount: 100 }, {}),
    ).toThrow(/new end date is required/i)
  })

  it("only supports the declared subscription statuses", () => {
    expect(SUBSCRIPTION_STATUSES).toContain("Active")
    expect(SUBSCRIPTION_STATUSES).toContain("Cancelled")
  })
})
