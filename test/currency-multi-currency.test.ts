import { describe, it, expect } from "vitest"
import {
  roundToDecimals,
  decimalsFor,
  convertWithRate,
  pickRateAsOf,
  resolveRate,
  computeGainLoss,
  type DirectedRate,
  type RatePoint,
} from "@/lib/currency/math"

// ---------------------------------------------------------------------------
// SPEC 159 — Multi-Currency: Phase 4 — rounding + historical rates.
// Exercises the pure FX math the server model and API delegate to.
// ---------------------------------------------------------------------------

describe("roundToDecimals — accounting rounding", () => {
  it("rounds half away from zero at 2 decimals", () => {
    expect(roundToDecimals(1.005, 2)).toBe(1.01)
    expect(roundToDecimals(2.675, 2)).toBe(2.68) // classic binary-float trap
    expect(roundToDecimals(0.125, 2)).toBe(0.13)
  })

  it("rounds negatives symmetrically (gain/loss parity)", () => {
    expect(roundToDecimals(-1.005, 2)).toBe(-1.01)
    expect(roundToDecimals(-2.675, 2)).toBe(-2.68)
  })

  it("honours zero-decimal and three-decimal precision", () => {
    expect(roundToDecimals(83.4, 0)).toBe(83)
    expect(roundToDecimals(83.5, 0)).toBe(84)
    expect(roundToDecimals(0.123456, 3)).toBe(0.123)
    expect(roundToDecimals(0.123556, 3)).toBe(0.124)
  })

  it("normalises -0 to 0 and guards non-finite input", () => {
    expect(Object.is(roundToDecimals(-0.0001, 2), 0)).toBe(true)
    expect(roundToDecimals(Number.NaN, 2)).toBe(0)
    expect(roundToDecimals(Number.POSITIVE_INFINITY, 2)).toBe(0)
  })
})

describe("decimalsFor — currency precision", () => {
  it("defaults to 2 and knows zero/three-decimal currencies", () => {
    expect(decimalsFor("INR")).toBe(2)
    expect(decimalsFor("usd")).toBe(2)
    expect(decimalsFor("JPY")).toBe(0)
    expect(decimalsFor("KWD")).toBe(3)
  })

  it("lets an explicit catalogue override win", () => {
    expect(decimalsFor("JPY", 2)).toBe(2)
    expect(decimalsFor("XYZ", 4)).toBe(4)
    expect(decimalsFor("XYZ")).toBe(2) // unknown -> default
  })
})

describe("convertWithRate — QUOTE->BASE, rounded to base precision", () => {
  it("multiplies then rounds to the target currency", () => {
    // 100 USD at 83.256 INR/USD -> 8325.60 INR
    expect(convertWithRate(100, 83.256, 2)).toBe(8325.6)
    // Into a zero-decimal base currency
    expect(convertWithRate(10, 149.37, 0)).toBe(1494)
  })

  it("is safe on bad input", () => {
    expect(convertWithRate(Number.NaN, 83, 2)).toBe(0)
    expect(convertWithRate(100, Number.NaN, 2)).toBe(0)
  })
})

describe("pickRateAsOf — historical rate selection", () => {
  const points: RatePoint[] = [
    { rate_date: "2026-01-01", rate: 82.0 },
    { rate_date: "2026-01-15", rate: 83.5 },
    { rate_date: "2026-02-01", rate: 84.25 },
  ]

  it("returns the most recent rate on or before the date", () => {
    expect(pickRateAsOf(points, "2026-01-20")).toBe(83.5)
    expect(pickRateAsOf(points, "2026-02-01")).toBe(84.25) // exact match is eligible
    expect(pickRateAsOf(points, "2026-12-31")).toBe(84.25) // latest wins
  })

  it("returns null before the first published rate", () => {
    expect(pickRateAsOf(points, "2025-12-31")).toBeNull()
  })

  it("ignores time components and unordered input", () => {
    const shuffled: RatePoint[] = [
      { rate_date: "2026-02-01T10:00:00Z", rate: 84.25 },
      { rate_date: "2026-01-01", rate: 82.0 },
      { rate_date: "2026-01-15", rate: 83.5 },
    ]
    expect(pickRateAsOf(shuffled, "2026-01-16")).toBe(83.5)
  })
})

describe("resolveRate — direct / inverse / triangulation", () => {
  // Rates published QUOTE->BASE with INR as the base currency.
  const rates: DirectedRate[] = [
    { quote: "USD", base: "INR", rate: 83.25 },
    { quote: "EUR", base: "INR", rate: 90.0 },
  ]

  it("returns 1 for identity", () => {
    expect(resolveRate("INR", "INR", rates)).toBe(1)
  })

  it("uses a direct rate", () => {
    expect(resolveRate("USD", "INR", rates)).toBe(83.25)
  })

  it("inverts when only the reverse pair exists", () => {
    expect(resolveRate("INR", "USD", rates)).toBeCloseTo(1 / 83.25, 10)
  })

  it("triangulates cross rates through the base currency", () => {
    // USD -> EUR = (USD->INR) / (EUR->INR)
    expect(resolveRate("USD", "EUR", rates, "INR")).toBeCloseTo(83.25 / 90.0, 10)
    // and the inverse direction
    expect(resolveRate("EUR", "USD", rates, "INR")).toBeCloseTo(90.0 / 83.25, 10)
  })

  it("returns null when no path exists", () => {
    expect(resolveRate("USD", "GBP", rates, "INR")).toBeNull()
  })

  it("round-trips a triangulated conversion within rounding tolerance", () => {
    const usdToEur = resolveRate("USD", "EUR", rates, "INR")!
    const inr = convertWithRate(100, resolveRate("USD", "INR", rates)!, 2) // 8325.00
    const eur = convertWithRate(100, usdToEur, 2)
    // 100 USD -> EUR should equal (100 USD -> INR) -> EUR
    const eurViaInr = convertWithRate(inr, resolveRate("INR", "EUR", rates, "INR")!, 2)
    expect(eur).toBeCloseTo(eurViaInr, 2)
  })
})

describe("computeGainLoss — realized/unrealized FX difference", () => {
  it("books a gain when the settlement rate rises", () => {
    // 1000 USD booked at 82.00, settled at 83.50 (base INR, 2 dp)
    const r = computeGainLoss({ amount: 1000, bookedRate: 82.0, settleRate: 83.5, baseDecimals: 2 })
    expect(r.baseBooked).toBe(82000)
    expect(r.baseSettled).toBe(83500)
    expect(r.gainLoss).toBe(1500)
  })

  it("books a loss when the settlement rate falls", () => {
    const r = computeGainLoss({ amount: 1000, bookedRate: 83.5, settleRate: 82.0, baseDecimals: 2 })
    expect(r.gainLoss).toBe(-1500)
  })

  it("reconciles exactly: baseSettled - baseBooked === gainLoss", () => {
    const r = computeGainLoss({ amount: 1234.56, bookedRate: 82.137, settleRate: 83.919, baseDecimals: 2 })
    expect(roundToDecimals(r.baseSettled - r.baseBooked, 2)).toBe(r.gainLoss)
  })

  it("is zero when the rate is unchanged", () => {
    const r = computeGainLoss({ amount: 500, bookedRate: 83.25, settleRate: 83.25, baseDecimals: 2 })
    expect(r.gainLoss).toBe(0)
  })
})
