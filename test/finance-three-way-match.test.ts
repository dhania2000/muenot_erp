import { describe, it, expect } from "vitest"
import {
  evaluateThreeWayMatch,
  normalizeTolerances,
  validateTolerancePayload,
  parseResolvePayload,
  summarizeMatch,
  DEFAULT_TOLERANCES,
  type MatchInput,
} from "@/lib/finance-three-way-match"

// Spec37 (#201) — Purchase three-way matching engine.
//
// Pure, DB-free control logic (lib/finance-three-way-match.ts). These tests pin
// the four scenarios the spec calls out — overbilling, partial delivery,
// duplicate bill, currency rounding — plus the tolerance/override validators
// that guard the settings and resolve APIs. The exact numbers asserted here are
// the exact numbers a checker sees and that hold or release payment.

/** A clean, fully-matched single-receipt / single-bill baseline. */
function baseline(overrides: Partial<MatchInput> = {}): MatchInput {
  return {
    orderedQuantity: 100,
    poUnitPrice: 10,
    poTaxable: 1000,
    poCurrency: "INR",
    poGstRate: 18,
    grnCount: 1,
    acceptedQuantity: 100,
    receivedValue: 1000,
    billedQuantity: 100,
    billUnitPrice: 10,
    billTaxable: 1000,
    billCurrency: "INR",
    billGstRate: 18,
    otherBilledQuantity: 0,
    otherBilledTaxable: 0,
    duplicateBill: false,
    receipts: [
      { grnId: "GRN-1", receiptDate: "2027-01-01", receivedQuantity: 100, acceptedQuantity: 100, rejectedQuantity: 0, receivedValue: 1000 },
    ],
    ...overrides,
  }
}

describe("evaluateThreeWayMatch — happy path", () => {
  it("fully matches an in-agreement PO / GRN / bill and never holds payment", () => {
    const r = evaluateThreeWayMatch(baseline())
    expect(r.status).toBe("matched")
    expect(r.paymentHold).toBe(false)
    expect(r.exceptions).toHaveLength(0)
    expect(r.categories).toEqual([])
    expect(r.context?.partialDelivery).toBe(false)
  })
})

describe("evaluateThreeWayMatch — overbilling", () => {
  it("holds payment when the billed quantity exceeds the accepted quantity", () => {
    const r = evaluateThreeWayMatch(baseline({ billedQuantity: 120, billTaxable: 1200 }))
    expect(r.status).toBe("exception")
    expect(r.paymentHold).toBe(true)
    expect(r.categories).toContain("quantity_over")
    expect(r.categories).toContain("amount_over")
    const qty = r.variances.find((v) => v.dimension === "quantity")!
    expect(qty.expected).toBe(100)
    expect(qty.actual).toBe(120)
    expect(qty.variance).toBe(20)
  })

  it("counts sibling bills against the same PO so the LAST bill trips the cap", () => {
    // 80 already billed on other bills; this bill of 40 pushes cumulative to 120 > 100.
    const r = evaluateThreeWayMatch(
      baseline({ billedQuantity: 40, billTaxable: 400, otherBilledQuantity: 80, otherBilledTaxable: 800 }),
    )
    expect(r.status).toBe("exception")
    const qty = r.variances.find((v) => v.dimension === "quantity")!
    expect(qty.actual).toBe(120)
    expect(qty.category).toBe("quantity_over")
  })

  it("respects a configured quantity tolerance before flagging an over-bill", () => {
    const r = evaluateThreeWayMatch(baseline({ billedQuantity: 102, billTaxable: 1020 }), { quantityPercent: 5 })
    const qty = r.variances.find((v) => v.dimension === "quantity")!
    expect(qty.status).toBe("within_tolerance")
    expect(r.categories).not.toContain("quantity_over")
  })
})

describe("evaluateThreeWayMatch — partial delivery", () => {
  it("flags partial delivery but does not over-bill when billing only what was received", () => {
    // Ordered 100, only 60 received/accepted, bill for the 60 received.
    const r = evaluateThreeWayMatch(
      baseline({
        acceptedQuantity: 60,
        receivedValue: 600,
        billedQuantity: 60,
        billTaxable: 600,
        receipts: [
          { grnId: "GRN-1", receiptDate: "2027-01-01", receivedQuantity: 60, acceptedQuantity: 60, rejectedQuantity: 0, receivedValue: 600 },
        ],
      }),
    )
    expect(r.context?.partialDelivery).toBe(true)
    expect(r.categories).not.toContain("quantity_over")
    expect(r.paymentHold).toBe(false)
  })

  it("holds payment when a bill exceeds a partial receipt (billed 100 vs received 60)", () => {
    const r = evaluateThreeWayMatch(
      baseline({ acceptedQuantity: 60, receivedValue: 600, billedQuantity: 100, billTaxable: 1000 }),
    )
    expect(r.status).toBe("exception")
    expect(r.categories).toContain("quantity_over")
  })

  it("aggregates split receipts into one accepted total", () => {
    const r = evaluateThreeWayMatch(
      baseline({
        acceptedQuantity: 100,
        receivedValue: 1000,
        grnCount: 2,
        receipts: [
          { grnId: "GRN-1", receiptDate: "2027-01-01", receivedQuantity: 40, acceptedQuantity: 40, rejectedQuantity: 0, receivedValue: 400 },
          { grnId: "GRN-2", receiptDate: "2027-01-05", receivedQuantity: 60, acceptedQuantity: 60, rejectedQuantity: 0, receivedValue: 600 },
        ],
      }),
    )
    expect(r.status).toBe("matched")
    expect(r.context?.receipts).toHaveLength(2)
  })

  it("holds payment when no goods have been received at all", () => {
    const r = evaluateThreeWayMatch(baseline({ grnCount: 0, acceptedQuantity: 0, receivedValue: 0, receipts: [] }))
    expect(r.status).toBe("exception")
    expect(r.categories).toContain("no_receipt")
    expect(r.paymentHold).toBe(true)
  })
})

describe("evaluateThreeWayMatch — duplicate bill", () => {
  it("holds payment when a duplicate vendor bill is flagged", () => {
    const r = evaluateThreeWayMatch(baseline({ duplicateBill: true }))
    expect(r.status).toBe("exception")
    expect(r.categories).toContain("duplicate_bill")
    const dup = r.variances.find((v) => v.dimension === "duplicate")!
    expect(dup.status).toBe("exception")
  })
})

describe("evaluateThreeWayMatch — currency", () => {
  it("holds payment when the bill currency differs from the PO", () => {
    const r = evaluateThreeWayMatch(baseline({ billCurrency: "USD" }))
    expect(r.status).toBe("exception")
    expect(r.categories).toContain("currency_mismatch")
  })

  it("absorbs sub-rupee currency rounding within the absolute amount slack", () => {
    // 1000.00 / 7 units => 142.857.. rounded unit price; line value drifts a paisa.
    const r = evaluateThreeWayMatch(
      baseline({
        orderedQuantity: 7,
        poUnitPrice: 142.86,
        poTaxable: 1000,
        acceptedQuantity: 7,
        receivedValue: 1000,
        billedQuantity: 7,
        billUnitPrice: 142.85,
        billTaxable: 999.99,
        receipts: [
          { grnId: "GRN-1", receiptDate: "2027-01-01", receivedQuantity: 7, acceptedQuantity: 7, rejectedQuantity: 0, receivedValue: 1000 },
        ],
      }),
      DEFAULT_TOLERANCES,
    )
    // A one-paisa drift is not an exception under the default 1.00 absolute slack.
    expect(r.paymentHold).toBe(false)
    expect(r.categories).not.toContain("amount_over")
    expect(r.categories).not.toContain("price_variance")
  })

  it("flags a real amount over-bill beyond the rounding slack", () => {
    const r = evaluateThreeWayMatch(baseline({ billTaxable: 1050 }))
    expect(r.categories).toContain("amount_over")
    const amt = r.variances.find((v) => v.dimension === "amount")!
    expect(amt.expected).toBe(1000)
    expect(amt.actual).toBe(1050)
  })

  it("flags a tax-rate mismatch against the PO", () => {
    const r = evaluateThreeWayMatch(baseline({ billGstRate: 12 }))
    expect(r.categories).toContain("tax_mismatch")
  })
})

describe("normalizeTolerances", () => {
  it("returns the safe defaults for null input", () => {
    expect(normalizeTolerances(null)).toEqual(DEFAULT_TOLERANCES)
  })
  it("clamps out-of-range values rather than rejecting them", () => {
    const t = normalizeTolerances({ quantityPercent: 999, pricePercent: -5, amountPercent: "3", amountAbsolute: 50 })
    expect(t.quantityPercent).toBe(100)
    expect(t.pricePercent).toBe(0)
    expect(t.amountPercent).toBe(3)
    expect(t.amountAbsolute).toBe(50)
  })
})

describe("validateTolerancePayload", () => {
  it("rejects a missing field", () => {
    const r = validateTolerancePayload({ quantityPercent: 1, pricePercent: 1, amountPercent: 1 })
    expect(r.ok).toBe(false)
  })
  it("rejects an out-of-range value instead of silently clamping", () => {
    const r = validateTolerancePayload({ quantityPercent: 200, pricePercent: 1, amountPercent: 1, amountAbsolute: 1 })
    expect(r.ok).toBe(false)
  })
  it("accepts a complete, in-range payload", () => {
    const r = validateTolerancePayload({ quantityPercent: 2, pricePercent: 1.5, amountPercent: 1, amountAbsolute: 5 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.pricePercent).toBe(1.5)
  })
})

describe("parseResolvePayload", () => {
  it("requires a valid decision", () => {
    expect(parseResolvePayload({ decision: "maybe", note: "a".repeat(20) }).ok).toBe(false)
  })
  it("requires a substantial justification note", () => {
    expect(parseResolvePayload({ decision: "approve", note: "short" }).ok).toBe(false)
  })
  it("accepts a well-formed override", () => {
    const r = parseResolvePayload({ decision: "reject", note: "Vendor overbilled us by 20 units; disputed." })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.decision).toBe("reject")
  })
})

describe("summarizeMatch", () => {
  it("summarizes a clean match and an exception", () => {
    expect(summarizeMatch(evaluateThreeWayMatch(baseline()))).toBe("Fully matched")
    expect(summarizeMatch(evaluateThreeWayMatch(baseline({ duplicateBill: true })))).toMatch(/Exception/)
  })
})
