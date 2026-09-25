import { round2 } from "@/lib/billing/billing-math"

/**
 * SaaS GST computation (pure, dependency-free).
 * ---------------------------------------------------------------------------
 * India GST split for the platform's own SaaS invoices to customer tenants.
 * Given a tax amount and the seller state vs the place of supply, split the tax
 * into either IGST (inter-state supply) or CGST + SGST (intra-state supply).
 *
 * Money convention: every component is cent-rounded, and for an intra-state
 * supply CGST + SGST always re-sum to the exact `tax_total` already persisted on
 * the invoice (any odd cent lands on CGST) so the GST split never drifts the
 * invoice total and always reconciles. Signs are preserved so a credit note
 * (negative tax) splits into negative components.
 *
 * This module is intentionally pure — it takes state codes as input rather than
 * importing the server-only GSTIN client — so it is fully unit-testable and can
 * be composed by the DB-backed billing engine.
 */

export type SupplyType = "intra_state" | "inter_state"

export type GstSplit = {
  supplyType: SupplyType
  /** Applied tax rate percentages, halved for CGST/SGST on intra-state supply. */
  igstRate: number
  cgstRate: number
  sgstRate: number
  igst: number
  cgst: number
  sgst: number
  taxTotal: number
}

/** The two-digit GST state code from a GSTIN or a bare code; null when absent. */
export function gstStateCode(gstinOrCode: string | null | undefined): string | null {
  const raw = String(gstinOrCode ?? "").trim().toUpperCase()
  if (!raw) return null
  const two = raw.slice(0, 2)
  return /^\d{2}$/.test(two) ? two : null
}

/**
 * Resolve the supply type from the seller's state and the place of supply.
 * Intra-state (CGST + SGST) only when both codes are known and identical;
 * otherwise the supply is treated as inter-state (IGST). Defaulting the unknown
 * case to inter-state is the conservative GST treatment (a single combined levy
 * rather than splitting across two state components we cannot substantiate).
 */
export function resolveSupplyType(
  sellerStateCode: string | null | undefined,
  placeOfSupplyStateCode: string | null | undefined,
): SupplyType {
  const seller = gstStateCode(sellerStateCode)
  const pos = gstStateCode(placeOfSupplyStateCode)
  if (seller && pos && seller === pos) return "intra_state"
  return "inter_state"
}

/**
 * Split an already-computed tax total into IGST or CGST/SGST for the supply
 * type. `ratePercent` is the invoice's combined GST rate, echoed back split for
 * display (CGST/SGST each carry half the rate on an intra-state supply).
 */
export function splitGst(taxTotal: number, supplyType: SupplyType, ratePercent = 0): GstSplit {
  const total = round2(Number.isFinite(taxTotal) ? taxTotal : 0)
  const rate = Number.isFinite(ratePercent) && ratePercent > 0 ? ratePercent : 0

  if (supplyType === "intra_state") {
    const cgst = round2(total / 2)
    const sgst = round2(total - cgst) // remainder cent lands here so the pair re-sums exactly
    return {
      supplyType,
      igstRate: 0,
      cgstRate: round2(rate / 2),
      sgstRate: round2(rate / 2),
      igst: 0,
      cgst,
      sgst,
      taxTotal: total,
    }
  }

  return {
    supplyType,
    igstRate: rate,
    cgstRate: 0,
    sgstRate: 0,
    igst: total,
    cgst: 0,
    sgst: 0,
    taxTotal: total,
  }
}

/**
 * One-shot helper: resolve the supply type from seller/place-of-supply states
 * and split the tax total accordingly.
 */
export function computeGstBreakdown(input: {
  taxTotal: number
  ratePercent?: number
  sellerStateCode?: string | null
  placeOfSupplyStateCode?: string | null
}): GstSplit {
  const supplyType = resolveSupplyType(input.sellerStateCode, input.placeOfSupplyStateCode)
  return splitGst(input.taxTotal, supplyType, input.ratePercent ?? 0)
}
