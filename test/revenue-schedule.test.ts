import { describe, expect, it } from "vitest"
import { buildRecognitionSchedule, monthsBetween } from "@/lib/billing/revenue-schedule"
import { allocateReversal } from "@/lib/billing/revenue-recognition"
import { round2 } from "@/lib/billing/billing-math"

/**
 * Spec6 (#240-241) — Pure, DB-free validation of prepaid revenue recognition:
 * the straight-line schedule that spreads a prepaid multi-year subscription
 * across its service months (cent-exact), and the reversal allocator that
 * cancels the LATEST unrecognized months first for a mid-term credit note.
 */

describe("monthsBetween", () => {
  it("counts whole calendar months across a subscription period", () => {
    expect(monthsBetween("2026-01-01", "2027-01-01")).toBe(12)
    expect(monthsBetween("2026-01-01", "2028-01-01")).toBe(24)
    expect(monthsBetween("2026-01-15", "2026-02-15")).toBe(1)
  })
  it("clamps to at least one month for same/degenerate periods", () => {
    expect(monthsBetween("2026-01-01", "2026-01-01")).toBe(1)
    expect(monthsBetween("2026-05-01", "2026-01-01")).toBe(1)
    expect(monthsBetween("", "")).toBe(1)
  })
})

describe("buildRecognitionSchedule", () => {
  it("spreads a yearly prepay into 12 equal monthly slices", () => {
    const periods = buildRecognitionSchedule({ amount: 1200, startDate: "2026-01-01", months: 12 })
    expect(periods).toHaveLength(12)
    expect(periods.every((p) => p.amount === 100)).toBe(true)
    expect(periods[0].periodMonth).toBe("2026-01")
    expect(periods[11].periodMonth).toBe("2026-12")
  })

  it("keeps the schedule cent-exact — the last month absorbs the rounding remainder", () => {
    const periods = buildRecognitionSchedule({ amount: 100, startDate: "2026-01-01", months: 3 })
    const sum = round2(periods.reduce((s, p) => s + p.amount, 0))
    expect(sum).toBe(100)
    expect(periods[0].amount).toBe(33.33)
    expect(periods[1].amount).toBe(33.33)
    expect(periods[2].amount).toBe(33.34) // remainder lands on the final month
  })

  it("spreads a multi-year (60-month) prepay exactly", () => {
    const amount = 5999.99
    const periods = buildRecognitionSchedule({ amount, startDate: "2026-03-10", months: 60 })
    expect(periods).toHaveLength(60)
    expect(round2(periods.reduce((s, p) => s + p.amount, 0))).toBe(amount)
    expect(periods[0].periodMonth).toBe("2026-03")
    expect(periods[59].periodMonth).toBe("2031-02")
  })

  it("advances month tags across the year boundary", () => {
    const periods = buildRecognitionSchedule({ amount: 300, startDate: "2026-11-01", months: 4 })
    expect(periods.map((p) => p.periodMonth)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"])
  })

  it("returns nothing for a zero amount", () => {
    expect(buildRecognitionSchedule({ amount: 0, startDate: "2026-01-01", months: 12 })).toEqual([])
  })
})

describe("allocateReversal", () => {
  const latestFirst = [
    { id: 3, amount: 100 },
    { id: 2, amount: 100 },
    { id: 1, amount: 100 },
  ]

  it("takes from the entries in the order given (caller orders latest-first)", () => {
    const { reductions, taken } = allocateReversal(latestFirst, 150)
    expect(taken).toBe(150)
    expect(reductions).toEqual([
      { id: 3, take: 100, remaining: 0 },
      { id: 2, take: 50, remaining: 50 },
    ])
  })

  it("never takes more than is unrecognized", () => {
    const { taken, reductions } = allocateReversal(latestFirst, 500)
    expect(taken).toBe(300)
    expect(reductions).toHaveLength(3)
    expect(reductions.every((r) => r.remaining === 0)).toBe(true)
  })

  it("takes nothing for a non-positive request", () => {
    expect(allocateReversal(latestFirst, 0)).toEqual({ reductions: [], taken: 0 })
    expect(allocateReversal(latestFirst, -50)).toEqual({ reductions: [], taken: 0 })
  })
})
