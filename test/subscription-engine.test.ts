import { describe, expect, it } from "vitest"
import {
  DEFAULT_LIFECYCLE,
  addDays,
  addMonths,
  addTerm,
  daysBetween,
  dunningPhase,
  hasProductAccess,
  isBillingTerm,
  isSubscriptionStatus,
  normalizeLifecycleConfig,
  reconcileLifecycle,
  termMonths,
  type BillingTerm,
  type LifecycleState,
} from "@/lib/billing/subscription-lifecycle"

/**
 * SPEC 16 — Phase 4. Pure, DB-free validation of the subscription lifecycle:
 * term/date math, the dunning ladder, auto-renewal roll-forward, grace periods,
 * trial handling and terminal-state immutability.
 */

describe("term math", () => {
  it("maps each sold term to the right number of months", () => {
    expect(termMonths("monthly")).toBe(1)
    expect(termMonths("yearly")).toBe(12)
    expect(termMonths("two_year")).toBe(24)
    expect(termMonths("five_year")).toBe(60)
  })

  it("advances a date by exactly one term", () => {
    expect(addTerm("2026-01-15", "monthly")).toBe("2026-02-15")
    expect(addTerm("2026-01-15", "yearly")).toBe("2027-01-15")
    expect(addTerm("2026-01-15", "two_year")).toBe("2028-01-15")
    expect(addTerm("2026-01-15", "five_year")).toBe("2031-01-15")
  })

  it("clamps month-end overflow (Jan 31 + 1mo = Feb 28/29)", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28")
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29") // leap year
  })

  it("adds days across month boundaries", () => {
    expect(addDays("2026-01-30", 5)).toBe("2026-02-04")
  })

  it("computes signed day gaps", () => {
    expect(daysBetween("2026-01-01", "2026-01-08")).toBe(7)
    expect(daysBetween("2026-01-08", "2026-01-01")).toBe(-7)
  })
})

describe("guards", () => {
  it("validates terms and statuses", () => {
    expect(isBillingTerm("five_year")).toBe(true)
    expect(isBillingTerm("weekly")).toBe(false)
    expect(isSubscriptionStatus("grace")).toBe(true)
    expect(isSubscriptionStatus("paused")).toBe(false)
  })

  it("knows which statuses retain product access", () => {
    expect(hasProductAccess("active")).toBe(true)
    expect(hasProductAccess("trial")).toBe(true)
    expect(hasProductAccess("grace")).toBe(true)
    expect(hasProductAccess("suspended")).toBe(false)
    expect(hasProductAccess("expired")).toBe(false)
  })

  it("normalizes lifecycle config with safe fallbacks", () => {
    expect(normalizeLifecycleConfig(null)).toEqual(DEFAULT_LIFECYCLE)
    expect(normalizeLifecycleConfig({ pastDueDays: -3, graceDays: 5, suspendDays: NaN })).toEqual({
      pastDueDays: DEFAULT_LIFECYCLE.pastDueDays,
      graceDays: 5,
      suspendDays: DEFAULT_LIFECYCLE.suspendDays,
    })
  })
})

describe("dunningPhase (7 past-due / 14 grace / 30 suspend)", () => {
  const cfg = DEFAULT_LIFECYCLE
  const due = "2026-01-01"
  it("is current before the due date", () => {
    expect(dunningPhase(due, "2025-12-20", cfg)).toBe("current")
  })
  it("is past_due within the first 7 days", () => {
    expect(dunningPhase(due, "2026-01-01", cfg)).toBe("past_due")
    expect(dunningPhase(due, "2026-01-07", cfg)).toBe("past_due")
  })
  it("is grace on days 7..20", () => {
    expect(dunningPhase(due, "2026-01-08", cfg)).toBe("grace")
    expect(dunningPhase(due, "2026-01-20", cfg)).toBe("grace")
  })
  it("is suspended on days 21..50", () => {
    expect(dunningPhase(due, "2026-01-22", cfg)).toBe("suspended")
    expect(dunningPhase(due, "2026-02-19", cfg)).toBe("suspended")
  })
  it("is expired after the suspend window", () => {
    expect(dunningPhase(due, "2026-03-15", cfg)).toBe("expired")
  })
})

function baseState(overrides: Partial<LifecycleState> = {}): LifecycleState {
  return {
    status: "active",
    term: "monthly" as BillingTerm,
    autoRenew: false,
    cancelAtPeriodEnd: false,
    trialEndDate: null,
    currentPeriodStart: "2026-01-01",
    currentPeriodEnd: "2026-02-01",
    config: DEFAULT_LIFECYCLE,
    ...overrides,
  }
}

describe("reconcileLifecycle — trial", () => {
  it("stays trial inside the trial window", () => {
    const r = reconcileLifecycle(
      baseState({ status: "trial", trialEndDate: "2026-01-20", currentPeriodEnd: "2026-02-20" }),
      "2026-01-10",
    )
    expect(r.status).toBe("trial")
  })

  it("becomes active once the trial ends and the paid period is running", () => {
    const r = reconcileLifecycle(
      baseState({
        status: "trial",
        trialEndDate: "2026-01-20",
        currentPeriodStart: "2026-01-20",
        currentPeriodEnd: "2026-02-20",
      }),
      "2026-01-25",
    )
    expect(r.status).toBe("active")
    expect(r.changed).toBe(true)
  })
})

describe("reconcileLifecycle — dunning ladder (no auto-renew)", () => {
  it("stays active before period end", () => {
    const r = reconcileLifecycle(baseState(), "2026-01-15")
    expect(r.status).toBe("active")
  })
  it("moves to past_due right after period end", () => {
    const r = reconcileLifecycle(baseState(), "2026-02-03")
    expect(r.status).toBe("past_due")
  })
  it("moves to grace after the past-due window", () => {
    const r = reconcileLifecycle(baseState(), "2026-02-12")
    expect(r.status).toBe("grace")
  })
  it("moves to suspended after grace", () => {
    const r = reconcileLifecycle(baseState(), "2026-02-25")
    expect(r.status).toBe("suspended")
  })
  it("moves to expired after suspension", () => {
    const r = reconcileLifecycle(baseState(), "2026-04-30")
    expect(r.status).toBe("expired")
  })
})

describe("reconcileLifecycle — auto-renew", () => {
  it("rolls the period forward one term and stays active", () => {
    const r = reconcileLifecycle(baseState({ autoRenew: true }), "2026-02-10")
    expect(r.status).toBe("active")
    expect(r.renewalsApplied).toBe(1)
    expect(r.currentPeriodStart).toBe("2026-02-01")
    expect(r.currentPeriodEnd).toBe("2026-03-01")
  })

  it("catches up multiple missed periods in one pass", () => {
    const r = reconcileLifecycle(baseState({ autoRenew: true }), "2026-04-10")
    expect(r.status).toBe("active")
    expect(r.renewalsApplied).toBe(3) // Feb, Mar, Apr
    expect(r.currentPeriodEnd).toBe("2026-05-01")
  })

  it("does not renew when still inside the current period", () => {
    const r = reconcileLifecycle(baseState({ autoRenew: true }), "2026-01-15")
    expect(r.status).toBe("active")
    expect(r.renewalsApplied).toBe(0)
  })

  it("cancel-at-period-end overrides auto-renew and finalises to cancelled", () => {
    const r = reconcileLifecycle(
      baseState({ autoRenew: true, cancelAtPeriodEnd: true }),
      "2026-02-10",
    )
    expect(r.status).toBe("cancelled")
  })
})

describe("reconcileLifecycle — terminal immutability", () => {
  it("never changes a cancelled subscription", () => {
    const r = reconcileLifecycle(baseState({ status: "cancelled" }), "2027-01-01")
    expect(r.status).toBe("cancelled")
    expect(r.changed).toBe(false)
  })
  it("never changes an expired subscription", () => {
    const r = reconcileLifecycle(baseState({ status: "expired" }), "2027-01-01")
    expect(r.status).toBe("expired")
    expect(r.changed).toBe(false)
  })
})

describe("reconcileLifecycle — custom lifecycle windows", () => {
  it("respects a plan's longer grace/suspend windows", () => {
    const cfg = { pastDueDays: 14, graceDays: 30, suspendDays: 60 }
    const state = baseState({ config: cfg, currentPeriodEnd: "2026-02-01" })
    expect(reconcileLifecycle(state, "2026-02-10").status).toBe("past_due") // day 9 < 14
    expect(reconcileLifecycle(state, "2026-02-20").status).toBe("grace") // day 19
    expect(reconcileLifecycle(state, "2026-04-01").status).toBe("suspended")
  })
})
