/**
 * Pure, client-safe money helpers shared by the Finance module configs,
 * the server CRUD factory, and the live totals shown in the form dialogs.
 * Keep this file free of server-only imports (db / auth / node builtins).
 */

import { formatCurrency, formatCurrencyIndian, type SettingsMap } from "@/lib/settings/format"

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
 * Currency formatter used across the Financial Reports surfaces (on-screen
 * table, view dialog, emailed HTML). Honours the configured currency settings
 * but renders in the Indian lakh/crore grouping with accounting-style negatives
 * — parenthesised, e.g. `(₹1,23,456.00)` — so a figure reads identically to the
 * PDF/Excel export engine and negatives/zeros are never formatted ad-hoc.
 */
export const inrReport = (n: any) => formatCurrencyIndian(Number(n) || 0, currencyConfig)

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

const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

/**
 * Fiscal quarter for a date, honouring the configured financial-year start
 * month. Q1 begins on the FY start month (April by default → Apr–Jun = Q1).
 */
export function fiscalQuarterFor(dateStr?: string | null, startMonth: number = fyStartMonth): string {
  if (!dateStr) return ""
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ""
  const offset = ((d.getMonth() - startMonth) + 12) % 12
  return `Q${Math.floor(offset / 3) + 1}`
}

/**
 * Centralized FTE financial period (Phase 9). Given the invoice date, derives
 * the financial year, month name, fiscal quarter and accounting period from the
 * single shared FY configuration so every FTE invoice is stamped consistently.
 */
export function fteFinancialPeriod(dateStr?: string | null) {
  const d = dateStr ? new Date(dateStr) : null
  const valid = d && !Number.isNaN(d.getTime())
  return {
    financial_year: financialYearFor(dateStr),
    month: valid ? MONTH_LONG[d!.getMonth()] : "",
    quarter: fiscalQuarterFor(dateStr),
    accounting_period: accountingPeriodFor(dateStr),
  }
}

/**
 * Pure, client-safe FTE client-billing engine (Phases 10–18).
 *
 * Shared by the live form preview (config `compute`) and the server-authoritative
 * recalculation (computeFteServerFields). It models the CLIENT invoice only:
 *
 *   Base billing (rate × billable days, or a flat monthly/fixed amount)
 *   + Overtime + Bonus/Extra + Other billable charges
 *   - Approved billing adjustment
 *   = Gross client billing
 *
 * GST is added and TDS withheld to reach Net receivable / Outstanding. Employee
 * payroll cost (salary, employer PF/ESI, other) is tracked SEPARATELY (Phase 17)
 * and only used to derive Gross margin / Margin % (Phase 18). Employee payroll
 * deductions (PF/ESI/PT/TDS on salary) are never mixed into client billing.
 */
export function computeFteBilling(v: Record<string, any>) {
  const workingDays = num(v.working_days)
  const paidDays = num(v.paid_days)
  const basis = String(v.billing_basis || "")

  // Billable days follow the configured billing policy (Phase 13) but an
  // explicit, HR-consistent value the user entered always wins.
  let billableDays = num(v.billable_days)
  if (billableDays <= 0) {
    if (basis === "Working Days") billableDays = workingDays
    else if (basis === "Monthly" || basis === "Fixed Amount") billableDays = paidDays || workingDays
    else billableDays = paidDays
  }
  const nonBillableDays = round2(Math.max(0, workingDays - billableDays))

  const rate = num(v.billing_rate)
  // Base billing derived from the billing basis + rate (Phase 14). A pre-entered
  // base_billing (or legacy gross_billing) is the fallback when no rate is set.
  let base = 0
  if (rate > 0) {
    if (basis === "Daily" || basis === "Working Days") base = round2(rate * billableDays)
    else if (basis === "Hourly") base = round2(rate * num(v.billable_hours || billableDays))
    else base = round2(rate) // Monthly / Fixed Amount → flat rate
  }
  if (base <= 0) base = round2(num(v.base_billing) || num(v.gross_billing))

  const overtime = num(v.billing_overtime)
  const bonus = num(v.billing_bonus)
  const other = num(v.other_charges)
  const adjustment = num(v.billing_adjustment)
  const gross = round2(base + overtime + bonus + other - adjustment)

  const gstAmount = round2((gross * num(v.gst_rate)) / 100)
  const tdsAmount = round2((gross * num(v.tds_rate)) / 100)
  const netReceivable = round2(gross + gstAmount - tdsAmount)
  const amountPaid = num(v.amount_paid)
  const outstanding = round2(netReceivable - amountPaid)

  // Employee cost is a separate ledger (Phase 17) — never deducted from billing.
  const employeeCost = round2(
    num(v.salary_cost) + num(v.employer_pf) + num(v.employer_esi) + num(v.other_employer_cost),
  )
  const grossMargin = round2(gross - employeeCost - num(v.other_allocated_cost))
  const marginPercent = gross > 0 ? round2((grossMargin / gross) * 100) : 0

  return {
    billable_days: round2(billableDays),
    non_billable_days: nonBillableDays,
    base_billing: round2(base),
    gross_client_billing: gross,
    gst_amount: gstAmount,
    tds_amount: tdsAmount,
    net_receivable: netReceivable,
    outstanding,
    employee_cost_total: employeeCost,
    gross_margin: grossMargin,
    margin_percent: marginPercent,
  }
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
