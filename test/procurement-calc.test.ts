import { describe, it, expect } from "vitest"
import {
  deriveRequisitionFields,
  selectRfqAward,
  deriveRfqFields,
  derivePoAmounts,
  deriveGrnFields,
  threeWayMatch,
  rollUpStage,
} from "@/lib/finance-procurement-calc"

describe("deriveRequisitionFields", () => {
  it("multiplies quantity by unit price", () => {
    expect(deriveRequisitionFields({ quantity: 10, estimated_unit_price: 25 }).estimated_amount).toBe(250)
  })
  it("clamps negative inputs to zero", () => {
    expect(deriveRequisitionFields({ quantity: -5, estimated_unit_price: 100 }).estimated_amount).toBe(0)
  })
})

describe("selectRfqAward", () => {
  const quotes = [
    { name: "Alpha", id: "V1", quote: 1000 },
    { name: "Beta", id: "V2", quote: 800 },
    { name: "Gamma", id: "V3", quote: 1200 },
  ]

  it("auto-awards the lowest quote and measures savings vs the highest", () => {
    const r = selectRfqAward(quotes, "Lowest Quote")
    expect(r.selectedVendorName).toBe("Beta")
    expect(r.awardedAmount).toBe(800)
    expect(r.lowestQuote).toBe(800)
    expect(r.highestQuote).toBe(1200)
    expect(r.estimatedSavings).toBe(400)
    expect(r.quoteCount).toBe(3)
  })

  it("honours a manual award to a quoting vendor", () => {
    const r = selectRfqAward(quotes, "Manual", { manualVendorName: "Gamma" })
    expect(r.selectedVendorName).toBe("Gamma")
    expect(r.awardedAmount).toBe(1200)
  })

  it("falls back to the explicit amount for a manual award with no matching quote", () => {
    const r = selectRfqAward(quotes, "Manual", { manualVendorName: "Delta", manualAwardedAmount: 900 })
    expect(r.selectedVendorName).toBe("Delta")
    expect(r.awardedAmount).toBe(900)
  })

  it("reports zero savings for a single quote", () => {
    const r = selectRfqAward([{ name: "Alpha", id: "V1", quote: 500 }], "Lowest Quote")
    expect(r.estimatedSavings).toBe(0)
    expect(r.awardedAmount).toBe(500)
  })

  it("ignores zero/negative quotes when counting", () => {
    const r = selectRfqAward([{ name: "A", quote: 0 }, { name: "B", quote: -10 }, { name: "C", quote: 300 }], "Lowest Quote")
    expect(r.quoteCount).toBe(1)
    expect(r.awardedAmount).toBe(300)
  })
})

describe("deriveRfqFields", () => {
  it("maps the three fixed vendor slots to the award decision", () => {
    const f = deriveRfqFields({
      vendor_1_name: "Alpha",
      vendor_1_quote: 1000,
      vendor_2_name: "Beta",
      vendor_2_quote: 800,
      vendor_3_name: "",
      vendor_3_quote: 0,
      selection_method: "Lowest Quote",
    })
    expect(f.quote_count).toBe(2)
    expect(f.selected_vendor_name).toBe("Beta")
    expect(f.awarded_amount).toBe(800)
    expect(f.estimated_savings).toBe(200)
  })
})

describe("derivePoAmounts", () => {
  it("applies discount before GST", () => {
    const a = derivePoAmounts({ quantity: 10, unit_price: 100, discount_percent: 10, gst_rate: 18 })
    expect(a.subtotal).toBe(1000)
    expect(a.discount_amount).toBe(100)
    expect(a.taxable_amount).toBe(900)
    expect(a.gst_amount).toBe(162)
    expect(a.total_amount).toBe(1062)
  })
  it("clamps discount to 100% and floors negatives", () => {
    const a = derivePoAmounts({ quantity: 1, unit_price: 100, discount_percent: 150, gst_rate: 0 })
    expect(a.discount_amount).toBe(100)
    expect(a.taxable_amount).toBe(0)
    expect(a.total_amount).toBe(0)
  })
  it("handles zero tax", () => {
    const a = derivePoAmounts({ quantity: 2, unit_price: 50, discount_percent: 0, gst_rate: 0 })
    expect(a.total_amount).toBe(100)
    expect(a.gst_amount).toBe(0)
  })
})

describe("deriveGrnFields", () => {
  it("marks a partial receipt", () => {
    const f = deriveGrnFields({ ordered_quantity: 100, received_quantity: 40, accepted_quantity: 40, unit_price: 10 })
    expect(f.receipt_status).toBe("Partial")
    expect(f.pending_quantity).toBe(60)
    expect(f.received_value).toBe(400)
  })
  it("marks a complete receipt", () => {
    const f = deriveGrnFields({ ordered_quantity: 100, received_quantity: 100, accepted_quantity: 100, unit_price: 10 })
    expect(f.receipt_status).toBe("Complete")
    expect(f.pending_quantity).toBe(0)
  })
  it("flags over-receipt and values only accepted stock", () => {
    const f = deriveGrnFields({ ordered_quantity: 100, received_quantity: 120, accepted_quantity: 110, unit_price: 10 })
    expect(f.receipt_status).toBe("Over-received")
    // accepted is clamped to received (120), not ordered
    expect(f.received_value).toBe(1100)
  })
  it("does not value rejected stock", () => {
    const f = deriveGrnFields({ ordered_quantity: 100, received_quantity: 100, accepted_quantity: 90, rejected_quantity: 10, unit_price: 10 })
    expect(f.received_value).toBe(900)
  })
})

describe("threeWayMatch", () => {
  it("matches within the price tolerance", () => {
    expect(threeWayMatch(100, 100, 1000, 1000.5).status).toBe("Matched")
  })
  it("detects a price mismatch", () => {
    expect(threeWayMatch(100, 100, 1000, 1200).status).toBe("Price Mismatch")
  })
  it("detects a quantity mismatch", () => {
    expect(threeWayMatch(100, 120, 1000, 1000).status).toBe("Quantity Mismatch")
  })
  it("detects a combined mismatch", () => {
    expect(threeWayMatch(100, 120, 1000, 1500).status).toBe("Mismatch")
  })
})

describe("rollUpStage", () => {
  it("sums values and counts", () => {
    const r = rollUpStage([{ amount: 100 }, { amount: 250.5 }, { amount: -5 }])
    expect(r.count).toBe(3)
    expect(r.totalValue).toBe(350.5)
  })
})
