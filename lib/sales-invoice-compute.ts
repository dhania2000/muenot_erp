/**
 * Server-authoritative money engine for Sales Invoices.
 *
 * All monetary fields are recomputed here from raw inputs so stored numbers can
 * be trusted regardless of what the browser sends. Supports multi-line invoices
 * with place-of-supply driven GST (intra-state → CGST+SGST, inter-state → IGST)
 * and derives header aggregates from the line items.
 */

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export type SupplyType = "Intra-State" | "Inter-State"

export type InvoiceItemInput = {
  item_id?: string | null
  description?: string | null
  hsn_sac?: string | null
  quantity?: any
  unit?: string | null
  rate?: any
  discount_type?: string | null
  discount_value?: any
  tax_rate?: any // total GST % for the line (split by supply type)
  cess_amount?: any
}

export type ComputedItem = {
  line_no: number
  item_id: string | null
  description: string | null
  hsn_sac: string | null
  quantity: number
  unit: string | null
  rate: number
  discount_type: string
  discount_value: number
  discount_amount: number
  taxable_value: number
  tax_rate: number
  cgst_percent: number
  cgst_amount: number
  sgst_percent: number
  sgst_amount: number
  igst_percent: number
  igst_amount: number
  cess_amount: number
  line_total: number
}

/** The Indian GST state code is the first two characters of a GSTIN. */
export function stateCodeFromGstin(gstin?: string | null): string | null {
  if (!gstin) return null
  const two = String(gstin).trim().slice(0, 2)
  return /^\d{2}$/.test(two) ? two : null
}

/**
 * Determine intra- vs inter-state supply. An explicit override wins; otherwise
 * it is derived from the seller and place-of-supply state codes. When the codes
 * are unknown it falls back to intra-state (the safe domestic default).
 */
export function resolveSupplyType(opts: {
  override?: string | null
  sellerStateCode?: string | null
  buyerStateCode?: string | null
}): SupplyType {
  if (opts.override === "Intra-State" || opts.override === "Inter-State") return opts.override
  const seller = opts.sellerStateCode
  const buyer = opts.buyerStateCode
  if (seller && buyer) return seller === buyer ? "Intra-State" : "Inter-State"
  return "Intra-State"
}

/** Whether the invoice type / tax mode allows GST to be applied at all. */
export function taxAllowedForType(invoiceType?: string | null): boolean {
  // Bill of Supply and Export invoices do not carry standard CGST/SGST/IGST.
  const t = (invoiceType || "").toLowerCase()
  if (t.includes("bill of supply")) return false
  if (t.includes("export")) return false
  return true
}

export function computeItem(
  line: InvoiceItemInput,
  index: number,
  supplyType: SupplyType,
  taxEnabled: boolean,
): ComputedItem {
  const quantity = num(line.quantity)
  const rate = num(line.rate)
  const gross = round2(quantity * rate)

  const discountType = line.discount_type === "percent" ? "percent" : "amount"
  const discountValue = num(line.discount_value)
  const discountAmount =
    discountType === "percent" ? round2((gross * discountValue) / 100) : round2(discountValue)

  const taxable = round2(Math.max(gross - discountAmount, 0))

  const gstRate = taxEnabled ? num(line.tax_rate) : 0
  let cgstPct = 0
  let sgstPct = 0
  let igstPct = 0
  if (gstRate > 0) {
    if (supplyType === "Intra-State") {
      cgstPct = round2(gstRate / 2)
      sgstPct = round2(gstRate / 2)
    } else {
      igstPct = gstRate
    }
  }

  const cgstAmount = round2((taxable * cgstPct) / 100)
  const sgstAmount = round2((taxable * sgstPct) / 100)
  const igstAmount = round2((taxable * igstPct) / 100)
  const cess = round2(num(line.cess_amount))
  const lineTotal = round2(taxable + cgstAmount + sgstAmount + igstAmount + cess)

  return {
    line_no: index + 1,
    item_id: line.item_id ?? null,
    description: line.description ?? null,
    hsn_sac: line.hsn_sac ?? null,
    quantity,
    unit: line.unit ?? null,
    rate,
    discount_type: discountType,
    discount_value: discountValue,
    discount_amount: discountAmount,
    taxable_value: taxable,
    tax_rate: gstRate,
    cgst_percent: cgstPct,
    cgst_amount: cgstAmount,
    sgst_percent: sgstPct,
    sgst_amount: sgstAmount,
    igst_percent: igstPct,
    igst_amount: igstAmount,
    cess_amount: cess,
    line_total: lineTotal,
  }
}

export type HeaderTotals = {
  taxable_amount: number
  discount: number
  cgst_amount: number
  sgst_amount: number
  igst_amount: number
  other_tax_cess: number
  invoice_total: number
  tds_amount: number
  net_receivable: number
  amount_received: number
  outstanding_amount: number
  payment_status: string
  // Blended header percents kept for the existing PDF / list columns.
  cgst_percent: number
  sgst_percent: number
  igst_percent: number
}

/** Aggregate computed line items into the header money fields. */
export function computeHeaderFromItems(
  items: ComputedItem[],
  opts: {
    tds_applicable?: any
    tds_rate?: any
    amount_received?: any
    payment_status?: string | null
  },
): HeaderTotals {
  const sum = (fn: (i: ComputedItem) => number) => round2(items.reduce((a, i) => a + fn(i), 0))

  const taxable = sum((i) => i.taxable_value)
  const discount = sum((i) => i.discount_amount)
  const cgst = sum((i) => i.cgst_amount)
  const sgst = sum((i) => i.sgst_amount)
  const igst = sum((i) => i.igst_amount)
  const cess = sum((i) => i.cess_amount)
  const invoiceTotal = round2(taxable + cgst + sgst + igst + cess)

  const tdsApplicable = opts.tds_applicable ? 1 : 0
  const tdsRate = num(opts.tds_rate)
  const tdsAmount = tdsApplicable ? round2((taxable * tdsRate) / 100) : 0
  const netReceivable = round2(invoiceTotal - tdsAmount)

  const amountReceived = round2(num(opts.amount_received))
  const outstanding = round2(netReceivable - amountReceived)

  let paymentStatus = opts.payment_status || ""
  if (!paymentStatus) {
    if (amountReceived <= 0) paymentStatus = "Unpaid"
    else if (amountReceived >= netReceivable) paymentStatus = "Paid"
    else paymentStatus = "Partially Paid"
  }

  // Blended percents (weighted by taxable) so single-rate invoices still show a
  // clean rate on the PDF, while mixed-rate invoices remain arithmetically sound
  // via the amount columns.
  const pct = (amt: number) => (taxable > 0 ? round2((amt / taxable) * 100) : 0)

  return {
    taxable_amount: taxable,
    discount,
    cgst_amount: cgst,
    sgst_amount: sgst,
    igst_amount: igst,
    other_tax_cess: cess,
    invoice_total: invoiceTotal,
    tds_amount: tdsAmount,
    net_receivable: netReceivable,
    amount_received: amountReceived,
    outstanding_amount: outstanding,
    payment_status: paymentStatus,
    cgst_percent: pct(cgst),
    sgst_percent: pct(sgst),
    igst_percent: pct(igst),
  }
}

/** Recompute only payment-derived fields (used for restricted post-issue edits). */
export function recomputePayment(netReceivable: number, amountReceivedRaw: any, current?: string | null) {
  const net = round2(num(netReceivable))
  const amountReceived = round2(num(amountReceivedRaw))
  const outstanding = round2(net - amountReceived)
  let paymentStatus = current || ""
  if (!paymentStatus) {
    if (amountReceived <= 0) paymentStatus = "Unpaid"
    else if (amountReceived >= net) paymentStatus = "Paid"
    else paymentStatus = "Partially Paid"
  }
  return { amount_received: amountReceived, outstanding_amount: outstanding, payment_status: paymentStatus }
}
