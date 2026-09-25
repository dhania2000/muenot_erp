import { describe, expect, it } from "vitest"
import {
  computeGstBreakdown,
  gstStateCode,
  resolveSupplyType,
  splitGst,
} from "@/lib/billing/saas-gst"
import { resolvePlaceOfSupply } from "@/lib/billing/saas-seller"

/**
 * Spec6 (#81-83) — Pure, DB-free validation of GST on the platform's SaaS
 * invoices: place-of-supply resolution, the intra-state (CGST+SGST) vs
 * inter-state (IGST) decision, cent-exact splitting, and credit-note reversal.
 */

describe("gstStateCode", () => {
  it("extracts the 2-digit state code from a GSTIN or a bare code", () => {
    expect(gstStateCode("29ABCDE1234F1Z5")).toBe("29")
    expect(gstStateCode("07")).toBe("07")
  })
  it("returns null for blank or non-numeric leads", () => {
    expect(gstStateCode("")).toBeNull()
    expect(gstStateCode(null)).toBeNull()
    expect(gstStateCode("AB12")).toBeNull()
  })
})

describe("resolveSupplyType", () => {
  it("is intra-state only when both known codes match", () => {
    expect(resolveSupplyType("29", "29")).toBe("intra_state")
  })
  it("is inter-state when the states differ", () => {
    expect(resolveSupplyType("29", "07")).toBe("inter_state")
  })
  it("defaults to inter-state (conservative single IGST levy) when either side is unknown", () => {
    expect(resolveSupplyType(null, "29")).toBe("inter_state")
    expect(resolveSupplyType("29", null)).toBe("inter_state")
    expect(resolveSupplyType(null, null)).toBe("inter_state")
  })
})

describe("splitGst", () => {
  it("splits an intra-state tax evenly into CGST + SGST that re-sum exactly", () => {
    const s = splitGst(180, "intra_state", 18)
    expect(s.cgst).toBe(90)
    expect(s.sgst).toBe(90)
    expect(s.igst).toBe(0)
    expect(s.cgstRate).toBe(9)
    expect(s.sgstRate).toBe(9)
    expect(s.cgst + s.sgst).toBe(s.taxTotal)
  })

  it("lands the odd remainder cent on SGST so the pair re-sums to the total", () => {
    const s = splitGst(0.01, "intra_state", 18)
    expect(s.cgst).toBe(0.01) // round2(0.005) rounds half away from zero
    expect(s.sgst).toBe(0) // remainder = total - cgst
    expect(s.cgst + s.sgst).toBe(0.01)

    const t = splitGst(18.01, "intra_state", 18)
    expect(t.cgst + t.sgst).toBeCloseTo(18.01, 2)
  })

  it("puts the whole tax into IGST for an inter-state supply", () => {
    const s = splitGst(180, "inter_state", 18)
    expect(s.igst).toBe(180)
    expect(s.igstRate).toBe(18)
    expect(s.cgst).toBe(0)
    expect(s.sgst).toBe(0)
  })

  it("reverses cleanly for a credit note (negative tax)", () => {
    const s = splitGst(-180, "intra_state", 18)
    expect(s.cgst).toBe(-90)
    expect(s.sgst).toBe(-90)
    expect(s.cgst + s.sgst).toBe(-180)
    const i = splitGst(-180, "inter_state", 18)
    expect(i.igst).toBe(-180)
  })

  it("coerces non-finite tax and rate to zero", () => {
    const s = splitGst(Number.NaN, "intra_state", Number.NaN)
    expect(s.taxTotal).toBe(0)
    expect(s.cgstRate).toBe(0)
  })
})

describe("computeGstBreakdown", () => {
  it("resolves supply type from seller + place-of-supply codes and splits accordingly", () => {
    const intra = computeGstBreakdown({ taxTotal: 100, ratePercent: 18, sellerStateCode: "29", placeOfSupplyStateCode: "29" })
    expect(intra.supplyType).toBe("intra_state")
    expect(intra.cgst).toBe(50)
    expect(intra.sgst).toBe(50)

    const inter = computeGstBreakdown({ taxTotal: 100, ratePercent: 18, sellerStateCode: "29", placeOfSupplyStateCode: "07" })
    expect(inter.supplyType).toBe("inter_state")
    expect(inter.igst).toBe(100)
  })
})

describe("resolvePlaceOfSupply", () => {
  it("takes the state from the customer's GSTIN first", () => {
    const pos = resolvePlaceOfSupply({ taxId: "29ABCDE1234F1Z5", state: "Ignored" })
    expect(pos.code).toBe("29")
    expect(pos.name).toBe("Karnataka")
  })
  it("falls back to mapping the billing state name when no GSTIN", () => {
    const pos = resolvePlaceOfSupply({ taxId: null, state: "Karnataka" })
    expect(pos.code).toBe("29")
    expect(pos.name).toBe("Karnataka")
  })
  it("keeps the raw state name but null code for an unknown/unregistered customer", () => {
    const pos = resolvePlaceOfSupply({ taxId: null, state: "Atlantis" })
    expect(pos.code).toBeNull()
    expect(pos.name).toBe("Atlantis")
  })
})
