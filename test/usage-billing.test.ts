import { describe, expect, it } from "vitest"
import {
  allowanceConsumedPercent,
  computeMeterOverage,
  reconcileUsageLines,
  type UsageBillingItem,
} from "@/lib/billing/usage-billing"

/**
 * Spec 5 — Pure, DB-free validation of the usage-based billing core: overage
 * pricing above a plan allowance, and reconciliation of metered usage into one
 * invoice line per metric with NO double charging across the scenarios the spec
 * calls out — late events, duplicate reconciliation runs, mid-cycle upgrades and
 * zero-usage invoices.
 */

// ---------------------------------------------------------------------------
// Overage math
// ---------------------------------------------------------------------------

describe("computeMeterOverage", () => {
  it("charges nothing within the allowance", () => {
    expect(computeMeterOverage(80, 100, 0.5)).toEqual({ overageUnits: 0, amount: 0 })
    expect(computeMeterOverage(100, 100, 0.5)).toEqual({ overageUnits: 0, amount: 0 })
  })

  it("charges the overage above the allowance at the overage rate", () => {
    expect(computeMeterOverage(150, 100, 0.5)).toEqual({ overageUnits: 50, amount: 25 })
  })

  it("treats a zero allowance as pay-per-use from the first unit", () => {
    expect(computeMeterOverage(10, 0, 2)).toEqual({ overageUnits: 10, amount: 20 })
  })

  it("rounds money to cents", () => {
    expect(computeMeterOverage(3, 0, 0.335)).toEqual({ overageUnits: 3, amount: 1.01 })
  })

  it("coerces garbage / negatives to zero", () => {
    expect(computeMeterOverage(-5, 100, 0.5)).toEqual({ overageUnits: 0, amount: 0 })
    expect(computeMeterOverage(Number.NaN, 100, 0.5)).toEqual({ overageUnits: 0, amount: 0 })
    expect(computeMeterOverage(150, -10, 0.5).overageUnits).toBe(150)
  })
})

describe("allowanceConsumedPercent", () => {
  it("reports consumption against a finite allowance", () => {
    expect(allowanceConsumedPercent(80, 100)).toBeCloseTo(80)
    expect(allowanceConsumedPercent(120, 100)).toBeCloseTo(120)
  })
  it("is null for a zero / unlimited allowance", () => {
    expect(allowanceConsumedPercent(50, 0)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Reconciliation — the core "one line per metric, no double charge" contract
// ---------------------------------------------------------------------------

const item = (over: Partial<UsageBillingItem> = {}): UsageBillingItem => ({
  meterKey: "sms_messages",
  label: "SMS",
  unit: "messages",
  used: 0,
  allowance: 100,
  overageRate: 0.05,
  ...over,
})

describe("reconcileUsageLines — first run", () => {
  it("emits no line for a zero-usage period (zero-usage invoice)", () => {
    const r = reconcileUsageLines([item({ used: 0 })])
    expect(r.lines).toHaveLength(0)
    expect(r.total).toBe(0)
  })

  it("emits no line while usage stays within the allowance", () => {
    const r = reconcileUsageLines([item({ used: 100 })])
    expect(r.lines).toHaveLength(0)
  })

  it("bills the overage once usage exceeds the allowance", () => {
    const r = reconcileUsageLines([item({ used: 250 })])
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0].quantity).toBe(150)
    expect(r.lines[0].amount).toBe(7.5)
    expect(r.total).toBe(7.5)
  })

  it("never charges when the overage rate is zero (soft/free overage)", () => {
    const r = reconcileUsageLines([item({ used: 500, overageRate: 0 })])
    expect(r.lines).toHaveLength(0)
  })
})

describe("reconcileUsageLines — one line per metric", () => {
  it("produces exactly one line per meter across many meters", () => {
    const r = reconcileUsageLines([
      item({ meterKey: "sms_messages", used: 150 }),
      item({ meterKey: "whatsapp_messages", label: "WhatsApp", used: 220, allowance: 200, overageRate: 0.02 }),
      item({ meterKey: "voice_calls", label: "Calls", used: 5, allowance: 10, overageRate: 1 }), // within allowance
    ])
    const keys = r.lines.map((l) => l.meterKey).sort()
    expect(keys).toEqual(["sms_messages", "whatsapp_messages"])
    expect(new Set(keys).size).toBe(keys.length) // no duplicates
  })

  it("merges duplicate items for the same meter into a single line", () => {
    const r = reconcileUsageLines([
      item({ meterKey: "api_calls", label: "API", used: 60, allowance: 100, overageRate: 0.01 }),
      item({ meterKey: "api_calls", label: "API", used: 60, allowance: 100, overageRate: 0.01 }),
    ])
    // 60 + 60 = 120 used, 100 allowance -> 20 overage, one line only.
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0].quantity).toBe(20)
  })
})

describe("reconcileUsageLines — late events (delta billing, no double charge)", () => {
  it("bills only the incremental overage when new events arrive after a prior run", () => {
    // First run already billed 150 overage units. Now total usage is 300 -> 200
    // overage; only the new 50 units should be billed.
    const r = reconcileUsageLines([item({ used: 300, alreadyBilledUnits: 150 })])
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0].quantity).toBe(50)
    expect(r.lines[0].totalOverageUnits).toBe(200)
    expect(r.lines[0].amount).toBe(2.5)
  })

  it("does not re-bill when a run repeats with no new usage (duplicate run)", () => {
    const r = reconcileUsageLines([item({ used: 250, alreadyBilledUnits: 150 })])
    expect(r.lines).toHaveLength(0)
    expect(r.total).toBe(0)
  })

  it("never emits a negative line if already-billed exceeds current overage", () => {
    const r = reconcileUsageLines([item({ used: 120, alreadyBilledUnits: 200 })])
    expect(r.lines).toHaveLength(0)
  })
})

describe("reconcileUsageLines — mid-cycle plan upgrade", () => {
  it("applies the new (larger) allowance so previously-billed overage can wash out", () => {
    // Upgraded plan raises the allowance from 100 to 400. Usage is 300, already
    // billed 150 overage on the old plan. New allowance covers everything -> the
    // period now has zero overage, and we never bill more (delta clamped to 0).
    const r = reconcileUsageLines([item({ used: 300, allowance: 400, alreadyBilledUnits: 150 })])
    expect(r.lines).toHaveLength(0)
  })

  it("bills against the upgraded allowance for genuinely new overage", () => {
    const r = reconcileUsageLines([item({ used: 500, allowance: 400, alreadyBilledUnits: 0 })])
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0].quantity).toBe(100)
  })
})
