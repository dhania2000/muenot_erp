import { num, round2 } from "@/lib/finance-calc"

/**
 * SPEC 136 — Procurement Management: the pure, side-effect-free procurement math
 * shared by the config-driven procurement modules (their `compute`), the
 * Procurement hub pipeline and the unit tests. No database or server imports
 * live here so it runs in the browser bundle, on the server and under Vitest
 * identically.
 *
 * The procurement lifecycle is modelled as a chain of header-level documents,
 * each a single row that carries its own summary amounts:
 *
 *   Requisition → RFQ → Purchase Order → Goods Receipt → (Bill → Payment)
 *
 * Bill (purchase-bills) and Payment (payments) already exist; this file owns the
 * four upstream documents and the three-way match that ties a receipt back to
 * its purchase order.
 */

// ---------------------------------------------------------------------------
// 1. Purchase Requisition — the internal "request" for goods/services.
// ---------------------------------------------------------------------------

export type RequisitionFields = {
  /** quantity × estimated unit price, floored at zero. */
  estimated_amount: number
}

/**
 * A requisition's estimated value is quantity × estimated unit price. Negative
 * inputs are clamped to zero so a typo can never create a negative request.
 */
export function deriveRequisitionFields(v: Record<string, any>): RequisitionFields {
  const quantity = Math.max(0, num(v.quantity))
  const unitPrice = Math.max(0, num(v.estimated_unit_price))
  return { estimated_amount: round2(quantity * unitPrice) }
}

// ---------------------------------------------------------------------------
// 2. RFQ — collect competing vendor quotes and award to one.
// ---------------------------------------------------------------------------

export type RfqVendorQuote = { name?: string | null; id?: string | null; quote: unknown }

export type RfqSelection = {
  quoteCount: number
  lowestQuote: number
  highestQuote: number
  selectedVendorName: string | null
  selectedVendorId: string | null
  awardedAmount: number
  /** highest received quote − awarded amount, never negative. */
  estimatedSavings: number
}

/**
 * Compare up to N vendor quotes and decide the award.
 *
 *  - "Lowest Quote"  → the cheapest positive quote wins automatically and both
 *    the selected vendor and the awarded amount are derived from it.
 *  - "Manual"        → the caller names the winning vendor; the awarded amount
 *    is that vendor's quote when it can be matched, otherwise the explicit
 *    `manualAwardedAmount` (or the lowest quote as a last resort).
 *
 * Savings are measured against the highest competing quote, so a single-quote
 * RFQ reports zero savings rather than a misleading number.
 */
export function selectRfqAward(
  quotes: RfqVendorQuote[],
  method: string | null | undefined,
  opts: { manualVendorName?: string | null; manualAwardedAmount?: unknown } = {},
): RfqSelection {
  const priced = quotes
    .map((q) => ({ name: q.name?.trim() || null, id: q.id?.trim() || null, quote: round2(Math.max(0, num(q.quote))) }))
    .filter((q) => q.quote > 0)

  const quoteCount = priced.length
  const lowestQuote = quoteCount ? Math.min(...priced.map((q) => q.quote)) : 0
  const highestQuote = quoteCount ? Math.max(...priced.map((q) => q.quote)) : 0

  const isManual = String(method ?? "").trim().toLowerCase() === "manual"

  let selected: { name: string | null; id: string | null; quote: number } | null = null
  if (isManual && opts.manualVendorName) {
    const target = opts.manualVendorName.trim().toLowerCase()
    selected = priced.find((q) => (q.name ?? "").toLowerCase() === target) ?? null
  }
  if (!selected && !isManual) {
    selected = priced.find((q) => q.quote === lowestQuote) ?? null
  }

  let awardedAmount: number
  if (selected) {
    awardedAmount = selected.quote
  } else if (isManual) {
    // Manual award to a vendor with no captured quote (or none matched): trust
    // the explicit amount, else fall back to the lowest quote on file.
    const manual = round2(Math.max(0, num(opts.manualAwardedAmount)))
    awardedAmount = manual > 0 ? manual : lowestQuote
  } else {
    awardedAmount = lowestQuote
  }

  const estimatedSavings = round2(Math.max(0, highestQuote - awardedAmount))

  return {
    quoteCount,
    lowestQuote,
    highestQuote,
    selectedVendorName: selected?.name ?? (isManual ? opts.manualVendorName?.trim() || null : null),
    selectedVendorId: selected?.id ?? null,
    awardedAmount,
    estimatedSavings,
  }
}

export type RfqFields = {
  quote_count: number
  lowest_quote: number
  highest_quote: number
  selected_vendor_name: string | null
  selected_vendor_id: string | null
  awarded_amount: number
  estimated_savings: number
}

/** Map a stored RFQ row (three fixed vendor slots) onto the award decision. */
export function deriveRfqFields(v: Record<string, any>): RfqFields {
  const quotes: RfqVendorQuote[] = [
    { name: v.vendor_1_name, id: v.vendor_1_id, quote: v.vendor_1_quote },
    { name: v.vendor_2_name, id: v.vendor_2_id, quote: v.vendor_2_quote },
    { name: v.vendor_3_name, id: v.vendor_3_id, quote: v.vendor_3_quote },
  ]
  const r = selectRfqAward(quotes, v.selection_method, {
    manualVendorName: v.selected_vendor_name,
    manualAwardedAmount: v.awarded_amount,
  })
  return {
    quote_count: r.quoteCount,
    lowest_quote: r.lowestQuote,
    highest_quote: r.highestQuote,
    selected_vendor_name: r.selectedVendorName,
    selected_vendor_id: r.selectedVendorId,
    awarded_amount: r.awardedAmount,
    estimated_savings: r.estimatedSavings,
  }
}

// ---------------------------------------------------------------------------
// 3. Purchase Order — the committed order with discount + GST.
// ---------------------------------------------------------------------------

export type PoAmounts = {
  subtotal: number
  discount_amount: number
  taxable_amount: number
  gst_amount: number
  total_amount: number
}

/**
 * Purchase-order money math, mirroring the tax stack used across Finance:
 *
 *   subtotal       = quantity × unit price
 *   discount       = subtotal × discount%          (clamped 0–100)
 *   taxable        = subtotal − discount
 *   GST            = taxable × GST%                 (clamped ≥ 0)
 *   total          = taxable + GST
 *
 * Every leg is rounded to paise and floored at zero so the order total is
 * always a clean, non-negative figure.
 */
export function derivePoAmounts(v: Record<string, any>): PoAmounts {
  const quantity = Math.max(0, num(v.quantity))
  const unitPrice = Math.max(0, num(v.unit_price))
  const subtotal = round2(quantity * unitPrice)

  const discountPercent = Math.min(100, Math.max(0, num(v.discount_percent)))
  const discountAmount = round2((subtotal * discountPercent) / 100)
  const taxableAmount = round2(Math.max(0, subtotal - discountAmount))

  const gstRate = Math.max(0, num(v.gst_rate))
  const gstAmount = round2((taxableAmount * gstRate) / 100)
  const totalAmount = round2(taxableAmount + gstAmount)

  return {
    subtotal,
    discount_amount: discountAmount,
    taxable_amount: taxableAmount,
    gst_amount: gstAmount,
    total_amount: totalAmount,
  }
}

// ---------------------------------------------------------------------------
// 4. Goods Receipt — receive against a PO, with a receipt status band.
// ---------------------------------------------------------------------------

export type ReceiptStatus = "Pending" | "Partial" | "Complete" | "Over-received"

export type GrnFields = {
  pending_quantity: number
  received_value: number
  receipt_status: ReceiptStatus
}

/**
 * Goods-receipt math against the ordered quantity.
 *
 *   pending    = max(0, ordered − received)
 *   value      = accepted quantity × unit price   (rejected stock is not valued)
 *   status     = Pending (nothing in) / Partial (some) / Complete (exactly all)
 *                / Over-received (more than ordered — flagged for review)
 *
 * Accepted quantity is clamped to what was actually received so a data-entry
 * slip cannot value more stock than arrived.
 */
export function deriveGrnFields(v: Record<string, any>): GrnFields {
  const ordered = Math.max(0, num(v.ordered_quantity))
  const received = Math.max(0, num(v.received_quantity))
  const accepted = Math.min(Math.max(0, num(v.accepted_quantity)), received)
  const unitPrice = Math.max(0, num(v.unit_price))

  const pending = round2(Math.max(0, ordered - received))
  const receivedValue = round2(accepted * unitPrice)

  let status: ReceiptStatus
  if (received <= 0) status = "Pending"
  else if (received > ordered) status = "Over-received"
  else if (received >= ordered) status = "Complete"
  else status = "Partial"

  return { pending_quantity: pending, received_value: receivedValue, receipt_status: status }
}

// ---------------------------------------------------------------------------
// 5. Three-way match — PO vs Goods Receipt vs Bill.
// ---------------------------------------------------------------------------

export type ThreeWayMatchStatus = "Matched" | "Quantity Mismatch" | "Price Mismatch" | "Mismatch"

export type ThreeWayMatch = {
  quantityMatched: boolean
  amountMatched: boolean
  status: ThreeWayMatchStatus
}

/**
 * Classic three-way match: the receipt should not exceed the ordered quantity
 * and the billed amount should equal the received value within a tolerance
 * (default ₹1, to absorb rounding across the tax stack). Returns a granular
 * status so the UI can tell a quantity problem apart from a price problem.
 */
export function threeWayMatch(
  orderedQty: unknown,
  receivedQty: unknown,
  receivedValue: unknown,
  billedAmount: unknown,
  tolerance = 1,
): ThreeWayMatch {
  const ordered = Math.max(0, num(orderedQty))
  const received = Math.max(0, num(receivedQty))
  const value = Math.max(0, num(receivedValue))
  const billed = Math.max(0, num(billedAmount))

  const quantityMatched = received <= ordered + 1e-9
  const amountMatched = Math.abs(billed - value) <= Math.max(0, num(tolerance))

  let status: ThreeWayMatchStatus
  if (quantityMatched && amountMatched) status = "Matched"
  else if (!quantityMatched && !amountMatched) status = "Mismatch"
  else if (!quantityMatched) status = "Quantity Mismatch"
  else status = "Price Mismatch"

  return { quantityMatched, amountMatched, status }
}

// ---------------------------------------------------------------------------
// 6. Pipeline rollup — value + count per lifecycle stage for the hub.
// ---------------------------------------------------------------------------

export type PipelineStageInput = { amount: unknown }

export type PipelineStageRollup = { count: number; totalValue: number }

/** Sum a stage's document values into a count + total, rounded to paise. */
export function rollUpStage(items: PipelineStageInput[]): PipelineStageRollup {
  let totalValue = 0
  for (const item of items) totalValue = round2(totalValue + Math.max(0, num(item.amount)))
  return { count: items.length, totalValue }
}
