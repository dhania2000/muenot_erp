import { describe, expect, it } from "vitest"
import {
  applyCredit,
  clamp,
  computeDiscount,
  computeInvoice,
  computeLine,
  computePlanChange,
  computeTax,
  daysBetween,
  deriveInvoiceStatus,
  evaluateCoupon,
  refundableAmount,
  round2,
  unusedProration,
  usedProration,
  validateRefund,
  type Coupon,
} from "@/lib/billing/billing-math"

/**
 * Phase 4. Pure, DB-free validation of every money calculation in the
 * billing engine: rounding, line extension, discounts, coupons, taxes (add-on
 * and inclusive), credits, invoice totalling, proration for upgrade/downgrade,
 * refunds and invoice-status derivation. These are the "financial edge cases".
 */

describe("round2", () => {
  it("rounds half away from zero and defeats float representation errors", () => {
    expect(round2(1.005)).toBe(1.01)
    expect(round2(2.675)).toBe(2.68)
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(round2(-1.005)).toBe(-1.01)
  })

  it("returns 0 for non-finite input", () => {
    expect(round2(Number.NaN)).toBe(0)
    expect(round2(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe("clamp", () => {
  it("bounds values into [min,max] and falls back to min for NaN", () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
    expect(clamp(Number.NaN, 3, 10)).toBe(3)
  })
})

describe("computeLine", () => {
  it("extends quantity * unitAmount and defaults taxable to true", () => {
    const line = computeLine({ quantity: 3, unitAmount: 9.99 })
    expect(line.amount).toBe(29.97)
    expect(line.taxable).toBe(true)
    expect(line.lineType).toBe("one_time")
  })

  it("treats malformed numbers as zero rather than NaN", () => {
    expect(computeLine({ quantity: Number.NaN, unitAmount: 10 }).amount).toBe(0)
    expect(computeLine({ quantity: 2, unitAmount: Number.NaN }).amount).toBe(0)
  })

  it("honours explicit non-taxable flag", () => {
    expect(computeLine({ quantity: 1, unitAmount: 100, taxable: false }).taxable).toBe(false)
  })
})

describe("computeDiscount", () => {
  it("computes percentage discounts", () => {
    expect(computeDiscount(200, { type: "percent", value: 10 })).toBe(20)
  })

  it("clamps a percentage above 100 to the full base", () => {
    expect(computeDiscount(200, { type: "percent", value: 150 })).toBe(200)
  })

  it("never lets a fixed discount exceed the base (no negative invoice)", () => {
    expect(computeDiscount(50, { type: "fixed", value: 80 })).toBe(50)
  })

  it("returns 0 for missing discount, zero base, or negative value", () => {
    expect(computeDiscount(100, null)).toBe(0)
    expect(computeDiscount(0, { type: "percent", value: 10 })).toBe(0)
    expect(computeDiscount(100, { type: "fixed", value: -5 })).toBe(0)
  })
})

describe("evaluateCoupon", () => {
  const base: Coupon = { discount_type: "percent", value: 20, is_active: true }

  it("applies an active in-window coupon", () => {
    const ev = evaluateCoupon(base, 100, { onDate: "2026-06-01" })
    expect(ev.applicable).toBe(true)
    expect(ev.discount).toBe(20)
  })

  it("rejects a missing coupon", () => {
    expect(evaluateCoupon(null, 100).applicable).toBe(false)
  })

  it("rejects an inactive coupon", () => {
    expect(evaluateCoupon({ ...base, is_active: false }, 100).applicable).toBe(false)
  })

  it("enforces the valid-from / valid-until window", () => {
    const c = { ...base, valid_from: "2026-06-01", valid_until: "2026-06-30" }
    expect(evaluateCoupon(c, 100, { onDate: "2026-05-31" }).reason).toBe("Coupon is not yet valid")
    expect(evaluateCoupon(c, 100, { onDate: "2026-07-01" }).reason).toBe("Coupon has expired")
    expect(evaluateCoupon(c, 100, { onDate: "2026-06-15" }).applicable).toBe(true)
  })

  it("enforces the redemption cap", () => {
    const c = { ...base, max_redemptions: 5, times_redeemed: 5 }
    expect(evaluateCoupon(c, 100).reason).toBe("Coupon redemption limit reached")
  })

  it("enforces currency match and minimum spend", () => {
    expect(evaluateCoupon({ ...base, currency: "USD" }, 100, { currency: "EUR" }).reason).toBe(
      "Coupon currency mismatch",
    )
    expect(evaluateCoupon({ ...base, min_amount: 500 }, 100).applicable).toBe(false)
  })

  it("rejects a coupon that yields no discount", () => {
    expect(evaluateCoupon({ discount_type: "fixed", value: 0 }, 100).applicable).toBe(false)
  })
})

describe("computeTax", () => {
  it("computes add-on tax and clamps a negative rate to 0", () => {
    expect(computeTax(100, 8.25)).toBe(8.25)
    expect(computeTax(100, -5)).toBe(0)
    expect(computeTax(-100, 10)).toBe(0)
  })
})

describe("applyCredit", () => {
  it("never applies more than the amount due or the available balance", () => {
    expect(applyCredit(100, 30)).toEqual({ applied: 30, remainingDue: 70, remainingCredit: 0 })
    expect(applyCredit(40, 100)).toEqual({ applied: 40, remainingDue: 0, remainingCredit: 60 })
  })

  it("floors negatives at zero", () => {
    expect(applyCredit(-10, -10)).toEqual({ applied: 0, remainingDue: 0, remainingCredit: 0 })
  })
})

describe("computeInvoice", () => {
  it("totals a simple taxable line with add-on tax", () => {
    const t = computeInvoice({
      lines: [{ quantity: 2, unitAmount: 50 }],
      taxRatePercent: 10,
    })
    expect(t.subtotal).toBe(100)
    expect(t.taxTotal).toBe(10)
    expect(t.total).toBe(110)
    expect(t.amountDue).toBe(110)
  })

  it("applies order discount and coupon before tax, clamped to subtotal", () => {
    const t = computeInvoice({
      lines: [{ quantity: 1, unitAmount: 100 }],
      discount: { type: "percent", value: 10 },
      couponDiscount: 500, // over-large, must clamp to remaining subtotal
      taxRatePercent: 10,
    })
    expect(t.discountTotal).toBe(100) // 10 order + 90 clamped coupon
    expect(t.discountedSubtotal).toBe(0)
    expect(t.taxTotal).toBe(0)
    expect(t.total).toBe(0)
  })

  it("spreads discount pro-rata across taxable and non-taxable lines", () => {
    // 100 taxable + 100 non-taxable, 50% off => discounted subtotal 100,
    // taxable share = 50%, taxable base = 50, tax @ 10% = 5.
    const t = computeInvoice({
      lines: [
        { quantity: 1, unitAmount: 100, taxable: true },
        { quantity: 1, unitAmount: 100, taxable: false },
      ],
      discount: { type: "percent", value: 50 },
      taxRatePercent: 10,
    })
    expect(t.subtotal).toBe(200)
    expect(t.discountedSubtotal).toBe(100)
    expect(t.taxableBase).toBe(50)
    expect(t.taxTotal).toBe(5)
    expect(t.total).toBe(105)
  })

  it("extracts tax when prices are tax-inclusive", () => {
    // 110 inclusive of 10% tax => tax component ~10, total stays 110.
    const t = computeInvoice({
      lines: [{ quantity: 1, unitAmount: 110 }],
      taxRatePercent: 10,
      taxInclusive: true,
    })
    expect(t.taxTotal).toBe(10)
    expect(t.total).toBe(110)
  })

  it("applies a signed adjustment after tax and floors the total at zero", () => {
    expect(
      computeInvoice({ lines: [{ quantity: 1, unitAmount: 100 }], adjustment: 25 }).total,
    ).toBe(125)
    expect(
      computeInvoice({ lines: [{ quantity: 1, unitAmount: 100 }], adjustment: -250 }).total,
    ).toBe(0)
  })

  it("consumes account credit against the invoice total to yield amount due", () => {
    const t = computeInvoice({
      lines: [{ quantity: 1, unitAmount: 100 }],
      taxRatePercent: 10,
      creditAvailable: 40,
    })
    expect(t.invoiceTotal).toBe(110)
    expect(t.creditApplied).toBe(40)
    expect(t.amountDue).toBe(70)
  })

  it("handles an empty invoice", () => {
    const t = computeInvoice({ lines: [] })
    expect(t.subtotal).toBe(0)
    expect(t.total).toBe(0)
    expect(t.amountDue).toBe(0)
  })
})

describe("proration", () => {
  const period = { periodStart: "2026-01-01", periodEnd: "2026-01-31" } // 30 days

  it("computes unused and used portions that sum to the full amount", () => {
    const unused = unusedProration({ ...period, changeDate: "2026-01-11", amount: 300 })
    const used = usedProration({ ...period, changeDate: "2026-01-11", amount: 300 })
    // 10 of 30 days used => 200 unused, 100 used.
    expect(unused).toBe(200)
    expect(used).toBe(100)
    expect(round2(unused + used)).toBe(300)
  })

  it("clamps a change date outside the period", () => {
    expect(unusedProration({ ...period, changeDate: "2025-12-01", amount: 300 })).toBe(300)
    expect(unusedProration({ ...period, changeDate: "2026-03-01", amount: 300 })).toBe(0)
  })

  it("returns 0 for a zero or inverted period (no divide-by-zero)", () => {
    expect(
      unusedProration({ periodStart: "2026-01-31", periodEnd: "2026-01-01", changeDate: "2026-01-15", amount: 300 }),
    ).toBe(0)
  })

  it("daysBetween is signed and whole-day", () => {
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30)
    expect(daysBetween("2026-01-31", "2026-01-01")).toBe(-30)
  })
})

describe("computePlanChange", () => {
  const period = { periodStart: "2026-01-01", periodEnd: "2026-01-31", changeDate: "2026-01-16" }

  it("bills a positive net for an upgrade mid-cycle", () => {
    // 15 of 30 days remain. old 100 -> unusedCredit 50; new 300 -> remainingCharge 150; net +100.
    const r = computePlanChange({ ...period, oldAmount: 100, newAmount: 300 })
    expect(r.kind).toBe("upgrade")
    expect(r.unusedCredit).toBe(50)
    expect(r.remainingCharge).toBe(150)
    expect(r.netAmount).toBe(100)
  })

  it("credits a negative net for a downgrade mid-cycle", () => {
    const r = computePlanChange({ ...period, oldAmount: 300, newAmount: 100 })
    expect(r.kind).toBe("downgrade")
    expect(r.netAmount).toBe(-100)
  })

  it("reports no change when amounts are equal", () => {
    const r = computePlanChange({ ...period, oldAmount: 200, newAmount: 200 })
    expect(r.kind).toBe("no_change")
    expect(r.netAmount).toBe(0)
  })
})

describe("refunds", () => {
  it("computes the remaining refundable amount", () => {
    expect(refundableAmount({ amountPaid: 100, amountRefunded: 30 })).toBe(70)
    expect(refundableAmount({ amountPaid: 100, amountRefunded: 100 })).toBe(0)
    expect(refundableAmount({ amountPaid: 50, amountRefunded: 80 })).toBe(0)
  })

  it("validates a requested refund against what remains", () => {
    expect(validateRefund(50, { amountPaid: 100, amountRefunded: 0 })).toEqual({
      ok: true,
      reason: null,
      amount: 50,
    })
    expect(validateRefund(0, { amountPaid: 100, amountRefunded: 0 }).ok).toBe(false)
    expect(validateRefund(150, { amountPaid: 100, amountRefunded: 0 }).ok).toBe(false)
  })
})

describe("deriveInvoiceStatus", () => {
  it("returns draft when not finalized", () => {
    expect(deriveInvoiceStatus({ total: 100, amountPaid: 0, amountRefunded: 0 }, { finalized: false })).toBe(
      "draft",
    )
  })

  it("passes through sticky terminal states", () => {
    expect(
      deriveInvoiceStatus({ total: 100, amountPaid: 0, amountRefunded: 0 }, { finalized: true, sticky: "void" }),
    ).toBe("void")
  })

  it("marks an open, partially-paid, and fully-paid invoice", () => {
    expect(deriveInvoiceStatus({ total: 100, amountPaid: 0, amountRefunded: 0 })).toBe("open")
    expect(deriveInvoiceStatus({ total: 100, amountPaid: 40, amountRefunded: 0 })).toBe("partially_paid")
    expect(deriveInvoiceStatus({ total: 100, amountPaid: 100, amountRefunded: 0 })).toBe("paid")
  })

  it("counts applied credit toward payment", () => {
    expect(deriveInvoiceStatus({ total: 100, amountPaid: 40, amountRefunded: 0, creditApplied: 60 })).toBe(
      "paid",
    )
  })

  it("marks a fully-refunded invoice and treats a zero total as paid", () => {
    expect(deriveInvoiceStatus({ total: 100, amountPaid: 100, amountRefunded: 100 })).toBe("refunded")
    expect(deriveInvoiceStatus({ total: 0, amountPaid: 0, amountRefunded: 0 })).toBe("paid")
  })
})
