/**
 * Pure, client-safe pricing + tax engine for sales quotations.
 *
 * This is the single source of truth for how a quotation's money is computed.
 * It runs unchanged in the browser (live totals in the dialog) and on the
 * server (authoritative persistence), so the numbers the user sees always
 * match what is stored. Keep this file free of server-only imports
 * (db / auth / node builtins).
 *
 * Indian GST model:
 *  - "Intra"  → tax splits into equal CGST + SGST halves (same-state supply).
 *  - "Inter"  → tax is a single IGST amount (other-state / export supply).
 *  - "None"   → no GST is applied even if a line carries a rate.
 *
 * Discounts apply in two stages: an optional per-line discount, then an
 * optional quotation-wide discount that is allocated proportionally across the
 * lines' post-line-discount amounts so tax is charged on the correct base.
 */

import { num, round2 } from "@/lib/finance-calc"

export type DiscountType = "none" | "percent" | "fixed"
export type TaxMode = "Exclusive" | "Inclusive"
export type GstTreatment = "Intra" | "Inter" | "None"

export const TAX_MODES: TaxMode[] = ["Exclusive", "Inclusive"]
export const GST_TREATMENTS: GstTreatment[] = ["Intra", "Inter", "None"]
export const DISCOUNT_TYPES: DiscountType[] = ["none", "percent", "fixed"]

/** Common Indian GST slab rates offered in the UI. */
export const GST_RATES = [0, 5, 12, 18, 28]

export type LineInput = {
  quantity: number | string
  rate: number | string
  discount_type?: DiscountType
  discount_value?: number | string
  tax_rate?: number | string
}

export type QuoteCalcInput = {
  items: LineInput[]
  taxMode: TaxMode
  gstTreatment: GstTreatment
  globalDiscountType?: DiscountType
  globalDiscountValue?: number | string
  /** Round the grand total to the nearest whole unit (rounding adjustment). */
  roundOff?: boolean
}

export type LineTotals = {
  quantity: number
  rate: number
  /** qty * rate, before any discount. */
  gross: number
  discountAmount: number
  /** Net after line + allocated global discount, tax-exclusive base. */
  taxableValue: number
  taxRate: number
  taxAmount: number
  cgst: number
  sgst: number
  igst: number
  /** taxableValue + taxAmount. */
  lineTotal: number
}

export type QuoteTotals = {
  lines: LineTotals[]
  /** Sum of gross line amounts (qty * rate). */
  subtotal: number
  lineDiscountTotal: number
  globalDiscountAmount: number
  discountTotal: number
  taxableValue: number
  cgstTotal: number
  sgstTotal: number
  igstTotal: number
  taxTotal: number
  roundOff: number
  grandTotal: number
}

function discountAmount(base: number, type: DiscountType | undefined, value: number): number {
  if (!type || type === "none" || value <= 0) return 0
  if (type === "percent") return round2((base * Math.min(value, 100)) / 100)
  return round2(Math.min(value, base))
}

export function computeQuoteTotals(input: QuoteCalcInput): QuoteTotals {
  const taxMode: TaxMode = input.taxMode === "Inclusive" ? "Inclusive" : "Exclusive"
  const gst: GstTreatment = GST_TREATMENTS.includes(input.gstTreatment) ? input.gstTreatment : "None"

  // Stage 1 — per line: gross and line-level discount.
  const staged = input.items.map((item) => {
    const quantity = Math.max(0, num(item.quantity))
    const rate = Math.max(0, num(item.rate))
    const gross = round2(quantity * rate)
    const lineDiscount = discountAmount(gross, item.discount_type, num(item.discount_value))
    const netAfterLine = round2(gross - lineDiscount)
    const taxRate = gst === "None" ? 0 : Math.max(0, num(item.tax_rate))
    return { quantity, rate, gross, lineDiscount, netAfterLine, taxRate }
  })

  const subtotal = round2(staged.reduce((s, l) => s + l.gross, 0))
  const lineDiscountTotal = round2(staged.reduce((s, l) => s + l.lineDiscount, 0))
  const netBase = round2(staged.reduce((s, l) => s + l.netAfterLine, 0))

  // Stage 2 — quotation-wide discount, allocated proportionally by netAfterLine.
  const globalDiscountAmount = discountAmount(netBase, input.globalDiscountType, num(input.globalDiscountValue))

  let allocated = 0
  const lines: LineTotals[] = staged.map((l, idx) => {
    // Allocate the global discount by weight; give the last line the remainder
    // so the allocation always sums to exactly globalDiscountAmount.
    let share: number
    if (netBase <= 0) {
      share = 0
    } else if (idx === staged.length - 1) {
      share = round2(globalDiscountAmount - allocated)
    } else {
      share = round2((l.netAfterLine / netBase) * globalDiscountAmount)
      allocated = round2(allocated + share)
    }

    const netAfterGlobal = round2(l.netAfterLine - share)

    let taxableValue: number
    let taxAmount: number
    if (taxMode === "Inclusive" && l.taxRate > 0) {
      taxableValue = round2(netAfterGlobal / (1 + l.taxRate / 100))
      taxAmount = round2(netAfterGlobal - taxableValue)
    } else {
      taxableValue = netAfterGlobal
      taxAmount = round2((netAfterGlobal * l.taxRate) / 100)
    }

    const cgst = gst === "Intra" ? round2(taxAmount / 2) : 0
    const sgst = gst === "Intra" ? round2(taxAmount - cgst) : 0
    const igst = gst === "Inter" ? taxAmount : 0
    const lineTotal = round2(taxableValue + taxAmount)

    return {
      quantity: l.quantity,
      rate: l.rate,
      gross: l.gross,
      discountAmount: round2(l.lineDiscount + share),
      taxableValue,
      taxRate: l.taxRate,
      taxAmount,
      cgst,
      sgst,
      igst,
      lineTotal,
    }
  })

  const taxableValue = round2(lines.reduce((s, l) => s + l.taxableValue, 0))
  const cgstTotal = round2(lines.reduce((s, l) => s + l.cgst, 0))
  const sgstTotal = round2(lines.reduce((s, l) => s + l.sgst, 0))
  const igstTotal = round2(lines.reduce((s, l) => s + l.igst, 0))
  const taxTotal = round2(cgstTotal + sgstTotal + igstTotal)

  const preRound = round2(taxableValue + taxTotal)
  let grandTotal = preRound
  let roundOff = 0
  if (input.roundOff) {
    grandTotal = Math.round(preRound)
    roundOff = round2(grandTotal - preRound)
  }

  return {
    lines,
    subtotal,
    lineDiscountTotal,
    globalDiscountAmount,
    discountTotal: round2(lineDiscountTotal + globalDiscountAmount),
    taxableValue,
    cgstTotal,
    sgstTotal,
    igstTotal,
    taxTotal,
    roundOff,
    grandTotal,
  }
}

/** Human-friendly label for a GST treatment. */
export function gstTreatmentLabel(gst: GstTreatment): string {
  if (gst === "Intra") return "CGST + SGST (intra-state)"
  if (gst === "Inter") return "IGST (inter-state)"
  return "No GST"
}
