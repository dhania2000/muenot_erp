/**
 * Pure, client-safe money helpers shared by the Finance module configs,
 * the server CRUD factory, and the live totals shown in the form dialogs.
 * Keep this file free of server-only imports (db / auth / node builtins).
 */

import { formatCurrency, type SettingsMap } from "@/lib/settings/format"

export const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

// Runtime currency config, populated from company settings by the
// SettingsProvider on the client (and can be set on the server if needed).
// Defaults to an empty map so formatCurrency falls back to INR (₹).
let currencyConfig: SettingsMap = {}

export function configureCurrency(settings: SettingsMap) {
  currencyConfig = settings || {}
}

const MONTH_INDEX: Record<string, number> = { January: 0, April: 3, July: 6, October: 9 }
let fyStartMonth = 3 // April by default

/** Set the financial-year start month from the "Financial Year Start Month" setting. */
export function configureFinancialYear(startMonthName?: string) {
  if (startMonthName && startMonthName in MONTH_INDEX) fyStartMonth = MONTH_INDEX[startMonthName]
}

/**
 * Financial year label derived from a date, honouring the configured start
 * month (defaults to April for the Indian financial year).
 */
export function financialYearFor(dateStr?: string | null, startMonth: number = fyStartMonth) {
  if (!dateStr) return ""
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ""
  const y = d.getFullYear()
  const start = d.getMonth() >= startMonth ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}

/** Derive a payment status when the user has not chosen one explicitly. */
export function autoPaymentStatus(net: number, paid: number, current?: string) {
  if (current) return current
  if (paid <= 0) return "Unpaid"
  if (paid >= net) return "Paid"
  return "Partially Paid"
}

// Currency display now honours the configured currency settings (symbol,
// position, decimals, separators) via the shared formatter. Falls back to
// ₹ / 2 decimals until configureCurrency() runs.
export const inr = (n: any) => formatCurrency(Number(n) || 0, currencyConfig)

export const inr0 = (n: any) =>
  formatCurrency(Number(n) || 0, { ...currencyConfig, "currency.decimals": "0" })

/**
 * Pure, client-safe Purchase Bill money engine (Phase 5).
 *
 * Single source of truth shared by the live form preview (config `compute`)
 * and the server-authoritative recalculation. Given the raw inputs plus an
 * optional resolved `supply_type` (Intra-State / Inter-State), it derives the
 * taxable value, the GST split, the gross, the TDS and the net/outstanding.
 *
 * GST split rules:
 *  - A single "gst_rate" combined with supply_type is authoritative: Intra
 *    splits evenly into CGST + SGST, Inter goes entirely to IGST.
 *  - When no gst_rate is given the explicit cgst/sgst/igst percents are used
 *    as-is (manual override / imported historical rows).
 * TDS is always computed on the taxable value (the statutory base), never on
 * the GST-inclusive gross.
 */
export function computePurchaseBill(v: Record<string, any>) {
  const qty = num(v.quantity)
  const rate = num(v.rate)
  const discount = round2(num(v.discount))
  const base = qty > 0 && rate > 0 ? qty * rate : num(v.taxable_amount) + discount
  const taxable = round2(Math.max(base - discount, 0))

  const gstRate = num(v.gst_rate)
  const interState = String(v.supply_type || "").trim() === "Inter-State"
  let cgstP = num(v.cgst_percent)
  let sgstP = num(v.sgst_percent)
  let igstP = num(v.igst_percent)
  if (gstRate > 0) {
    if (interState) {
      igstP = gstRate
      cgstP = 0
      sgstP = 0
    } else {
      cgstP = round2(gstRate / 2)
      sgstP = round2(gstRate / 2)
      igstP = 0
    }
  }

  const cgst = round2((taxable * cgstP) / 100)
  const sgst = round2((taxable * sgstP) / 100)
  const igst = round2((taxable * igstP) / 100)
  const cess = round2(num(v.other_tax_cess))
  const gross = round2(taxable + cgst + sgst + igst + cess)

  const tdsBase = taxable
  const tds = v.tds_applicable ? round2((tdsBase * num(v.tds_rate)) / 100) : 0
  const net = round2(gross - tds)
  const paid = round2(num(v.amount_paid))

  return {
    taxable_amount: taxable,
    discount,
    gst_rate: gstRate,
    cgst_percent: cgstP,
    sgst_percent: sgstP,
    igst_percent: igstP,
    cgst_amount: cgst,
    sgst_amount: sgst,
    igst_amount: igst,
    other_tax_cess: cess,
    gross_bill_amount: gross,
    tds_base: tdsBase,
    tds_amount: tds,
    net_payable: net,
    amount_paid: paid,
    outstanding_amount: round2(net - paid),
    payment_status: autoPaymentStatus(net, paid, v.payment_status),
    financial_year: v.financial_year || financialYearFor(v.bill_date),
  }
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** Accounting period label derived from a date, e.g. "Apr-2026". */
export function accountingPeriodFor(dateStr?: string | null): string {
  if (!dateStr) return ""
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ""
  return `${MONTH_SHORT[d.getMonth()]}-${d.getFullYear()}`
}

/**
 * Pure, client-safe Expense money engine (Phase 15).
 *
 * Single source of truth shared by the live form preview (config `compute`) and
 * the server-authoritative recalculation (computeExpenseServerFields). Given the
 * raw inputs it derives the taxable value, GST split, gross, TDS, the employee
 * advance adjustment (Phase 19/20) and the net payable / outstanding (Phase 17).
 *
 * GST split rules mirror Purchase Bills: a single `gst_rate` + `supply_type` is
 * authoritative (Intra splits into CGST+SGST, Inter goes to IGST); when no rate
 * is supplied the explicit cgst/sgst/igst amounts are used as-is (imported /
 * historical rows). TDS is always computed on the taxable value.
 */
export function computeExpense(v: Record<string, any>) {
  const qty = num(v.quantity)
  const rate = num(v.rate)
  const discount = round2(num(v.discount))
  const base = qty > 0 && rate > 0 ? qty * rate : num(v.taxable_amount) + discount
  const taxable = round2(Math.max(base - discount, 0))

  const gstApplicable = !!v.gst_applicable
  const gstRate = num(v.gst_rate)
  const interState = String(v.supply_type || "").trim() === "Inter-State"

  let cgst = round2(num(v.cgst_amount))
  let sgst = round2(num(v.sgst_amount))
  let igst = round2(num(v.igst_amount))
  if (gstApplicable && gstRate > 0) {
    if (interState) {
      igst = round2((taxable * gstRate) / 100)
      cgst = 0
      sgst = 0
    } else {
      cgst = round2((taxable * gstRate) / 2 / 100)
      sgst = round2((taxable * gstRate) / 2 / 100)
      igst = 0
    }
  } else if (!gstApplicable) {
    cgst = 0
    sgst = 0
    igst = 0
  }
  const cess = round2(num(v.cess_amount))
  const gstAmount = round2(cgst + sgst + igst)
  const gross = round2(taxable + cgst + sgst + igst + cess)

  const tds = v.tds_applicable ? round2((taxable * num(v.tds_rate)) / 100) : 0
  const netBeforeAdj = round2(gross - tds)

  // Phase 19/20 — employee advance adjustment.
  const advance = round2(num(v.advance_amount))
  const advanceAdjusted = advance > 0 ? round2(Math.min(advance, netBeforeAdj)) : 0
  const remainingAdvance = advance > 0 ? round2(advance - advanceAdjusted) : 0
  const additionalReimbursement = advance > 0 ? round2(Math.max(netBeforeAdj - advance, 0)) : 0
  const otherAdjustment = round2(num(v.other_adjustment))

  const netPayable = round2(Math.max(netBeforeAdj - advanceAdjusted - otherAdjustment, 0))
  const paid = round2(num(v.amount_paid))

  return {
    taxable_amount: taxable,
    discount,
    gst_rate: gstRate,
    cgst_amount: cgst,
    sgst_amount: sgst,
    igst_amount: igst,
    cess_amount: cess,
    gst_amount: gstAmount,
    gross_amount: gross,
    tds_amount: tds,
    advance_amount: advance,
    advance_adjusted: advanceAdjusted,
    remaining_advance: remainingAdvance,
    additional_reimbursement: additionalReimbursement,
    other_adjustment: otherAdjustment,
    net_payable: netPayable,
    amount_paid: paid,
    outstanding_amount: round2(netPayable - paid),
    payment_status: autoPaymentStatus(netPayable, paid, v.payment_status),
    financial_year: v.financial_year || financialYearFor(v.expense_date),
    accounting_period: v.accounting_period || accountingPeriodFor(v.expense_date),
  }
}

/** Add `days` to an ISO date string, returning YYYY-MM-DD (or "" when invalid). */
export function addDays(dateStr?: string | null, days?: any): string {
  if (!dateStr) return ""
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ""
  const n = Number(days)
  if (!Number.isFinite(n) || n <= 0) return ""
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}
