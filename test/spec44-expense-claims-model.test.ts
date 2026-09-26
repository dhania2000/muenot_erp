import { describe, expect, it } from "vitest"
import {
  MILEAGE_RATE,
  RECEIPT_THRESHOLD,
  categoryByKey,
  computeClaimTotals,
  computeLineAmount,
  hasBlockingViolations,
  validateClaim,
  type ClaimLine,
} from "@/lib/expense-claims-core"

/**
 * SPEC 44 — Expense/payroll/projects/resource planning. Pure, DB-free validation
 * of the shared expense-claim model (SPEC 127 core) that both the browser form
 * and the server engine re-run, so the money maths and policy gate can never
 * drift. Focus areas mandated by the spec: PARTIAL REIMBURSEMENT (corporate-card
 * spend is excluded from the employee's reimbursable total) and the policy
 * validation that blocks submission.
 */

function line(over: Partial<ClaimLine>): ClaimLine {
  return {
    category: over.category ?? "meals",
    description: over.description ?? "Lunch",
    date: over.date ?? "2026-03-01",
    amount: over.amount ?? 0,
    is_mileage: over.is_mileage,
    distance_km: over.distance_km,
    mileage_rate: over.mileage_rate,
    corporate_card: over.corporate_card,
    card_last4: over.card_last4,
    receipt_url: over.receipt_url ?? null,
  }
}

describe("computeLineAmount", () => {
  it("returns the rounded flat amount for a normal line", () => {
    expect(computeLineAmount(line({ amount: 199.005 }))).toBe(199.01)
  })

  it("derives mileage as distance × rate, defaulting the rate when absent", () => {
    expect(computeLineAmount(line({ is_mileage: true, distance_km: 10 }))).toBe(10 * MILEAGE_RATE)
    expect(computeLineAmount(line({ is_mileage: true, distance_km: 10, mileage_rate: 15 }))).toBe(150)
  })

  it("ignores the free-text amount on a mileage line", () => {
    expect(computeLineAmount(line({ is_mileage: true, distance_km: 5, amount: 99999 }))).toBe(5 * MILEAGE_RATE)
  })

  it("never returns a negative amount", () => {
    expect(computeLineAmount(line({ amount: -50 }))).toBe(0)
    expect(computeLineAmount(line({ is_mileage: true, distance_km: -5 }))).toBe(0)
  })
})

describe("computeClaimTotals — partial reimbursement", () => {
  it("excludes corporate-card spend from the reimbursable total", () => {
    // 2000 out-of-pocket + 3000 on the corporate card = 5000 gross, but only the
    // 2000 is owed back to the employee.
    const totals = computeClaimTotals([
      line({ amount: 2000 }),
      line({ amount: 3000, corporate_card: true }),
    ])
    expect(totals.gross).toBe(5000)
    expect(totals.corporateCard).toBe(3000)
    expect(totals.reimbursable).toBe(2000)
  })

  it("reconciles reimbursable + corporateCard back to gross", () => {
    const totals = computeClaimTotals([
      line({ amount: 1234.56 }),
      line({ amount: 765.44, corporate_card: true }),
      line({ is_mileage: true, distance_km: 20 }),
    ])
    expect(totals.reimbursable + totals.corporateCard).toBe(totals.gross)
  })

  it("tracks the mileage subtotal separately and counts mileage as reimbursable", () => {
    const totals = computeClaimTotals([line({ is_mileage: true, distance_km: 100 })])
    expect(totals.mileage).toBe(100 * MILEAGE_RATE)
    expect(totals.reimbursable).toBe(100 * MILEAGE_RATE)
    expect(totals.corporateCard).toBe(0)
  })

  it("returns all zeros for an empty claim", () => {
    expect(computeClaimTotals([])).toEqual({ gross: 0, reimbursable: 0, corporateCard: 0, mileage: 0 })
  })
})

describe("validateClaim — policy gate", () => {
  it("requires at least one line", () => {
    const v = validateClaim([])
    expect(hasBlockingViolations(v)).toBe(true)
    expect(v[0].line).toBe(0)
  })

  it("blocks a receipt-less line at or above the receipt threshold", () => {
    const v = validateClaim([line({ amount: RECEIPT_THRESHOLD, receipt_url: null })], { today: "2026-03-02" })
    expect(v.some((x) => x.severity === "error" && /receipt is required/i.test(x.message))).toBe(true)
    expect(hasBlockingViolations(v)).toBe(true)
  })

  it("exempts corporate-card and mileage lines from the receipt requirement", () => {
    const v = validateClaim(
      [
        line({ amount: 5000, corporate_card: true, receipt_url: null }),
        line({ is_mileage: true, distance_km: 200, receipt_url: null }),
      ],
      { today: "2026-03-02" },
    )
    expect(v.some((x) => /receipt is required/i.test(x.message))).toBe(false)
  })

  it("flags a category-cap breach as a non-blocking warning", () => {
    const cap = categoryByKey("meals")!.cap
    const v = validateClaim([line({ category: "meals", amount: cap + 1, receipt_url: "r" })], { today: "2026-03-02" })
    const warn = v.find((x) => /exceeds the policy cap/i.test(x.message))
    expect(warn?.severity).toBe("warning")
    expect(hasBlockingViolations(v)).toBe(false)
  })

  it("errors on an unknown category and a zero amount", () => {
    const v = validateClaim([line({ category: "", amount: 0, receipt_url: "r" })], { today: "2026-03-02" })
    expect(v.some((x) => x.severity === "error" && /category/i.test(x.message))).toBe(true)
    expect(v.some((x) => x.severity === "error" && /greater than zero/i.test(x.message))).toBe(true)
  })

  it("warns on a future-dated line without blocking", () => {
    const v = validateClaim([line({ amount: 100, date: "2999-01-01", receipt_url: "r" })], { today: "2026-03-02" })
    const warn = v.find((x) => /future/i.test(x.message))
    expect(warn?.severity).toBe("warning")
  })

  it("passes a clean, in-policy claim with no blocking violations", () => {
    const v = validateClaim(
      [line({ category: "meals", amount: 200, receipt_url: null }), line({ is_mileage: true, distance_km: 30 })],
      { today: "2026-03-02" },
    )
    expect(hasBlockingViolations(v)).toBe(false)
  })
})
