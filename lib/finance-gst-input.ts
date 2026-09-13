import "server-only"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { financialYearFor, num, round2 } from "@/lib/finance-calc"
import { ensureGstInputSchema } from "@/lib/finance-ensure"

// ---------------------------------------------------------------------------
// GST Input (ITC) engine — Phases 11–20 (server only).
//
// Every posted Purchase Bill projects into exactly one finance_gst_input row
// (idempotent, keyed by source + source_bill_id) that carries the tax split,
// the ITC ledger (gross / eligible / ineligible / reversal / net), the claim
// state and the GSTR-2B reconciliation state. From that register we derive the
// monthly and quarterly ITC summaries and reconcile the purchase register
// against the auto-drafted GSTR-2B.
// ---------------------------------------------------------------------------

/** Bill payment statuses that must NOT produce an ITC record. */
const EXCLUDED_STATUSES = new Set(["Cancelled", "Draft", "Void"])

/** Tax period YYYY-MM from an ISO date. */
export function periodOf(dateStr?: string | null): string | null {
  if (!dateStr) return null
  const s = String(dateStr).slice(0, 7)
  return /^\d{4}-\d{2}$/.test(s) ? s : null
}

/** Indian financial-year quarter label, e.g. "2026-27 Q1" (Apr–Jun). */
export function quarterOf(dateStr?: string | null): string | null {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return null
  const m = d.getMonth() + 1 // 1..12
  const fy = financialYearFor(dateStr)
  const q = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 && m <= 12 ? 3 : 4
  return `${fy} Q${q}`
}

type ItcLedger = {
  gross: number
  eligible: number
  ineligible: number
  reversal: number
  net: number
  cgst: number
  sgst: number
  igst: number
  cess: number
}

/**
 * Phase 16 — split the bill's total GST into the ITC ledger. When ITC is not
 * eligible the whole credit is ineligible; when eligible, an optional reversal
 * (e.g. Rule 42/43 common-credit reversal, blocked-credit proportion) is netted
 * off. The net eligible credit is split back across the tax heads pro-rata so
 * the electronic-credit-ledger heads stay balanced.
 */
export function computeItcLedger(opts: {
  cgst: number
  sgst: number
  igst: number
  cess: number
  eligible: boolean
  reversalAmount?: number
}): ItcLedger {
  const cgst = round2(num(opts.cgst))
  const sgst = round2(num(opts.sgst))
  const igst = round2(num(opts.igst))
  const cess = round2(num(opts.cess))
  const gross = round2(cgst + sgst + igst + cess)

  if (!opts.eligible || gross <= 0) {
    return { gross, eligible: 0, ineligible: gross, reversal: 0, net: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 }
  }

  const reversal = round2(Math.min(Math.max(num(opts.reversalAmount), 0), gross))
  const net = round2(gross - reversal)
  const factor = gross > 0 ? net / gross : 0
  return {
    gross,
    eligible: gross,
    ineligible: 0,
    reversal,
    net,
    cgst: round2(cgst * factor),
    sgst: round2(sgst * factor),
    igst: round2(igst * factor),
    cess: round2(cess * factor),
  }
}

/** Phase 15 — the register status derived from eligibility + claim state. */
function deriveStatus(eligible: boolean, claimed: boolean, reversal: number, net: number): string {
  if (!eligible) return "Ineligible"
  if (claimed) return "Claimed"
  if (reversal > 0 && net <= 0) return "Reversed"
  return "Available"
}

/** Classify the ITC head from the HSN/SAC + bill type (best-effort). */
function itcSection(bill: Record<string, any>): string {
  const type = String(bill.bill_type || "").toLowerCase()
  if (type.includes("asset") || type.includes("capital")) return "Capital Goods"
  const hsn = String(bill.hsn_sac || "").trim()
  // SAC codes (services) are 6 digits starting 99; HSN (goods) otherwise.
  if (hsn.startsWith("99")) return "Input Services"
  if (hsn) return "Inputs"
  return "Input Services"
}

/**
 * Phase 11/14 — project a single purchase bill into its GST Input record.
 * Idempotent: re-running updates the same row (keyed by source_bill_id) so
 * create → edit → re-post never duplicates a credit. Bills with no GST or in an
 * excluded status remove any previously-created record.
 */
export async function syncGstInputForBill(
  billId: string,
  opts: { createdBy?: number | null } = {},
): Promise<{ action: "upserted" | "removed"; gstInputId?: string }> {
  await ensureGstInputSchema()

  const [bill] = (await query<any[]>(`SELECT * FROM purchase_bills WHERE bill_id = ? LIMIT 1`, [billId])) as any[]
  if (!bill) {
    await query(`DELETE FROM finance_gst_input WHERE source = 'Purchase Bill' AND source_bill_id = ?`, [billId])
    return { action: "removed" }
  }

  const cgst = round2(num(bill.cgst_amount))
  const sgst = round2(num(bill.sgst_amount))
  const igst = round2(num(bill.igst_amount))
  const cess = round2(num(bill.other_tax_cess))
  const totalGst = round2(cgst + sgst + igst + cess)
  const status = String(bill.payment_status || "").trim()

  // No GST or an excluded status → no ITC record.
  if (totalGst <= 0 || EXCLUDED_STATUSES.has(status)) {
    await query(`DELETE FROM finance_gst_input WHERE source = 'Purchase Bill' AND source_bill_id = ?`, [billId])
    return { action: "removed" }
  }

  const eligible = Boolean(num(bill.itc_eligible))
  const claimed = Boolean(num(bill.itc_claimed))
  const reversal = round2(num(bill.itc_reversal_amount))
  const ledger = computeItcLedger({ cgst, sgst, igst, cess, eligible, reversalAmount: reversal })
  const registerStatus = deriveStatus(eligible, claimed, ledger.reversal, ledger.net)

  const billDate = bill.bill_date ? String(bill.bill_date).slice(0, 10) : null
  const period = periodOf(billDate)
  const quarter = quarterOf(billDate)
  const fy = bill.financial_year || financialYearFor(billDate)

  const [existing] = (await query<any[]>(
    `SELECT id, gst_input_id, reconciliation_status, gstr2b_reference, gstr2b_taxable, gstr2b_tax, match_variance
       FROM finance_gst_input WHERE source = 'Purchase Bill' AND source_bill_id = ? LIMIT 1`,
    [billId],
  )) as any[]

  const gstInputId = existing?.gst_input_id || (await nextRecordId("GIP", { allowCustom: true, digits: 6 }))

  const fields: Record<string, any> = {
    gst_input_id: gstInputId,
    source: "Purchase Bill",
    source_bill_id: billId,
    source_bill_ref: bill.bill_id,
    bill_number: bill.bill_number || null,
    bill_date: billDate,
    period,
    quarter,
    financial_year: fy || null,
    vendor_id: bill.vendor_id || null,
    vendor_name: bill.vendor_name || bill.vendor_legal_name || null,
    vendor_gstin: bill.vendor_gstin || null,
    vendor_state: bill.vendor_state || null,
    vendor_state_code: bill.vendor_state_code || null,
    place_of_supply: bill.place_of_supply || null,
    supply_type: bill.supply_type || null,
    taxable_amount: round2(num(bill.taxable_amount)),
    gst_rate: round2(num(bill.gst_rate)),
    cgst_amount: cgst,
    sgst_amount: sgst,
    igst_amount: igst,
    cess_amount: cess,
    total_gst: totalGst,
    itc_eligible: eligible ? 1 : 0,
    itc_section: itcSection(bill),
    itc_gross: ledger.gross,
    itc_eligible_amount: ledger.eligible,
    itc_ineligible_amount: ledger.ineligible,
    itc_reversal_amount: ledger.reversal,
    itc_net: ledger.net,
    itc_cgst: ledger.cgst,
    itc_sgst: ledger.sgst,
    itc_igst: ledger.igst,
    itc_cess: ledger.cess,
    itc_claimed: claimed ? 1 : 0,
    claimed_period: claimed ? period : null,
    status: registerStatus,
    narration: `Input GST on ${bill.bill_id}${bill.vendor_name ? ` — ${bill.vendor_name}` : ""}`,
  }

  if (existing) {
    // Preserve the reconciliation columns (owned by the reconcile flow), but
    // reset the derived match variance since the bill's tax may have changed.
    const cols = Object.keys(fields)
    await query(
      `UPDATE finance_gst_input SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id = ?`,
      [...cols.map((c) => fields[c]), existing.id],
    )
  } else {
    fields.reconciliation_status = "Unreconciled"
    fields.created_by = opts.createdBy ?? null
    const cols = Object.keys(fields)
    await query(
      `INSERT INTO finance_gst_input (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((c) => fields[c]),
    )
  }

  return { action: "upserted", gstInputId }
}

/** Remove the ITC record for a deleted bill. */
export async function deleteGstInputForBill(billId: string): Promise<void> {
  await ensureGstInputSchema()
  await query(`DELETE FROM finance_gst_input WHERE source = 'Purchase Bill' AND source_bill_id = ?`, [billId])
}

/** Expense approval states that must NOT produce an ITC record. */
const EXCLUDED_EXPENSE_STATUSES = new Set(["Rejected", "Cancelled", "Void"])

/**
 * Phase 7–13 — project a single Expense into the SAME centralized GST Input
 * register used by Purchase Bills (source = 'Expense', source_bill_id =
 * Expense ID). Idempotent: re-running updates the one keyed row so create →
 * edit → re-post never duplicates a credit, and an expense with no input GST /
 * in an excluded status removes any previously-created record.
 *
 * The claimable input tax is the GST charged on a normal expense, or the
 * self-assessed RCM tax on an RCM expense (Phase 5) — never both. Eligibility
 * follows the expense's own GST-credit flag (Phase 6), so a non-creditable
 * expense still books the tax but claims zero ITC.
 */
export async function syncGstInputForExpense(
  expenseId: string,
  opts: { createdBy?: number | null } = {},
): Promise<{ action: "upserted" | "removed"; gstInputId?: string }> {
  await ensureGstInputSchema()

  const [exp] = (await query<any[]>(`SELECT * FROM expenses WHERE expense_id = ? LIMIT 1`, [expenseId])) as any[]
  if (!exp) {
    await query(`DELETE FROM finance_gst_input WHERE source = 'Expense' AND source_bill_id = ?`, [expenseId])
    return { action: "removed" }
  }

  const rcm = Boolean(num(exp.rcm_applicable))
  // RCM tax is self-assessed on the expense; a normal expense carries the GST
  // charged by the vendor. Only one path contributes input tax.
  const cgst = rcm ? round2(num(exp.rcm_cgst)) : round2(num(exp.cgst_amount))
  const sgst = rcm ? round2(num(exp.rcm_sgst)) : round2(num(exp.sgst_amount))
  const igst = rcm ? round2(num(exp.rcm_igst)) : round2(num(exp.igst_amount))
  const cess = rcm ? 0 : round2(num(exp.cess_amount))
  const totalGst = round2(cgst + sgst + igst + cess)
  const status = String(exp.approval_status || "").trim()

  if (!num(exp.gst_applicable) || totalGst <= 0 || EXCLUDED_EXPENSE_STATUSES.has(status)) {
    await query(`DELETE FROM finance_gst_input WHERE source = 'Expense' AND source_bill_id = ?`, [expenseId])
    return { action: "removed" }
  }

  const eligible = Boolean(num(exp.gst_credit_eligible))
  const reversal = round2(num(exp.itc_reversal))
  const ledger = computeItcLedger({ cgst, sgst, igst, cess, eligible, reversalAmount: reversal })
  const registerStatus = deriveStatus(eligible, false, ledger.reversal, ledger.net)

  const expDate = exp.expense_date ? String(exp.expense_date).slice(0, 10) : null
  const period = periodOf(expDate)
  const quarter = quarterOf(expDate)
  const fy = exp.financial_year || financialYearFor(expDate)

  const [existing] = (await query<any[]>(
    `SELECT id, gst_input_id FROM finance_gst_input WHERE source = 'Expense' AND source_bill_id = ? LIMIT 1`,
    [expenseId],
  )) as any[]

  const gstInputId = existing?.gst_input_id || (await nextRecordId("GIP", { allowCustom: true, digits: 6 }))
  const payee = exp.vendor_name || exp.employee_name || exp.party_name || ""

  const fields: Record<string, any> = {
    gst_input_id: gstInputId,
    source: "Expense",
    source_bill_id: expenseId,
    source_bill_ref: exp.expense_id,
    source_transaction_id: exp.expense_id,
    bill_number: exp.vendor_invoice_number || exp.bill_receipt_no || null,
    bill_date: expDate,
    period,
    quarter,
    financial_year: fy || null,
    vendor_id: exp.vendor_id || null,
    vendor_name: exp.vendor_name || null,
    vendor_gstin: exp.vendor_gstin || null,
    vendor_pan: exp.vendor_pan || null,
    vendor_state: exp.vendor_state || null,
    vendor_state_code: exp.vendor_state_code || null,
    employee_id: exp.employee_id || null,
    employee_name: exp.employee_name || null,
    place_of_supply: exp.supply_location || exp.vendor_state || null,
    supply_type: exp.supply_type || null,
    hsn_sac: exp.hsn_sac || null,
    rcm_applicable: rcm ? 1 : 0,
    taxable_amount: round2(num(rcm ? exp.rcm_taxable_value || exp.taxable_amount : exp.taxable_amount)),
    gst_rate: round2(num(exp.gst_rate)),
    cgst_amount: cgst,
    sgst_amount: sgst,
    igst_amount: igst,
    cess_amount: cess,
    total_gst: totalGst,
    itc_eligible: eligible ? 1 : 0,
    itc_section: itcSection(exp),
    itc_gross: ledger.gross,
    itc_eligible_amount: ledger.eligible,
    itc_ineligible_amount: ledger.ineligible,
    itc_reversal_amount: ledger.reversal,
    itc_net: ledger.net,
    itc_cgst: ledger.cgst,
    itc_sgst: ledger.sgst,
    itc_igst: ledger.igst,
    itc_cess: ledger.cess,
    itc_claimed: 0,
    status: registerStatus,
    narration: `Input GST on expense ${exp.expense_id}${payee ? ` — ${payee}` : ""}${rcm ? " (RCM)" : ""}`,
  }

  if (existing) {
    const cols = Object.keys(fields)
    await query(
      `UPDATE finance_gst_input SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id = ?`,
      [...cols.map((c) => fields[c]), existing.id],
    )
  } else {
    fields.reconciliation_status = "Unreconciled"
    fields.created_by = opts.createdBy ?? null
    const cols = Object.keys(fields)
    await query(
      `INSERT INTO finance_gst_input (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((c) => fields[c]),
    )
  }

  return { action: "upserted", gstInputId }
}

/** Remove the ITC record for a deleted expense. */
export async function deleteGstInputForExpense(expenseId: string): Promise<void> {
  await ensureGstInputSchema()
  await query(`DELETE FROM finance_gst_input WHERE source = 'Expense' AND source_bill_id = ?`, [expenseId])
}

// ---------------------------------------------------------------------------
// Reads: register list + monthly / quarterly summaries + reconciliation
// ---------------------------------------------------------------------------

export type GstInputRow = Record<string, any>

/** Phase 12/13 — the GST Input register, optionally scoped to a period. */
export async function listGstInput(filters: {
  period?: string | null
  quarter?: string | null
  status?: string | null
  reconciliation?: string | null
} = {}): Promise<GstInputRow[]> {
  await ensureGstInputSchema()
  const where: string[] = []
  const args: any[] = []
  if (filters.period) { where.push("period = ?"); args.push(filters.period) }
  if (filters.quarter) { where.push("quarter = ?"); args.push(filters.quarter) }
  if (filters.status) { where.push("status = ?"); args.push(filters.status) }
  if (filters.reconciliation) { where.push("reconciliation_status = ?"); args.push(filters.reconciliation) }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""
  return (await query<any[]>(
    `SELECT * FROM finance_gst_input ${clause} ORDER BY bill_date DESC, id DESC`,
    args,
  )) as any[]
}

type ItcTotals = {
  count: number
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  total_gst: number
  itc_gross: number
  itc_eligible: number
  itc_ineligible: number
  itc_reversal: number
  itc_net: number
  itc_cgst: number
  itc_sgst: number
  itc_igst: number
  itc_cess: number
}

function totalsSelect(): string {
  return `
    COUNT(*) count,
    COALESCE(SUM(taxable_amount),0) taxable,
    COALESCE(SUM(cgst_amount),0) cgst,
    COALESCE(SUM(sgst_amount),0) sgst,
    COALESCE(SUM(igst_amount),0) igst,
    COALESCE(SUM(cess_amount),0) cess,
    COALESCE(SUM(total_gst),0) total_gst,
    COALESCE(SUM(itc_gross),0) itc_gross,
    COALESCE(SUM(itc_eligible_amount),0) itc_eligible,
    COALESCE(SUM(itc_ineligible_amount),0) itc_ineligible,
    COALESCE(SUM(itc_reversal_amount),0) itc_reversal,
    COALESCE(SUM(itc_net),0) itc_net,
    COALESCE(SUM(itc_cgst),0) itc_cgst,
    COALESCE(SUM(itc_sgst),0) itc_sgst,
    COALESCE(SUM(itc_igst),0) itc_igst,
    COALESCE(SUM(itc_cess),0) itc_cess`
}

/** Phase 19 — monthly ITC summary for a tax period (with recon + section splits). */
export async function gstInputMonthlySummary(period: string) {
  await ensureGstInputSchema()
  const [totals] = (await query<any[]>(
    `SELECT ${totalsSelect()} FROM finance_gst_input WHERE period = ?`,
    [period],
  )) as any[]

  const sectionWise = (await query<any[]>(
    `SELECT itc_section section, COUNT(*) count,
            COALESCE(SUM(itc_gross),0) itc_gross,
            COALESCE(SUM(itc_net),0) itc_net
       FROM finance_gst_input WHERE period = ?
      GROUP BY itc_section ORDER BY itc_net DESC`,
    [period],
  )) as any[]

  const reconWise = (await query<any[]>(
    `SELECT reconciliation_status status, COUNT(*) count,
            COALESCE(SUM(itc_net),0) itc_net
       FROM finance_gst_input WHERE period = ?
      GROUP BY reconciliation_status`,
    [period],
  )) as any[]

  const rows = await listGstInput({ period })
  return { period, totals: totals as ItcTotals, sectionWise, reconWise, rows }
}

/** Phase 20 — quarterly ITC roll-up for a financial year (4 FY quarters). */
export async function gstInputQuarterlySummary(financialYear: string) {
  await ensureGstInputSchema()
  const byQuarter = (await query<any[]>(
    `SELECT quarter, ${totalsSelect()}
       FROM finance_gst_input WHERE financial_year = ?
      GROUP BY quarter ORDER BY quarter`,
    [financialYear],
  )) as any[]

  const byMonth = (await query<any[]>(
    `SELECT period, ${totalsSelect()}
       FROM finance_gst_input WHERE financial_year = ?
      GROUP BY period ORDER BY period`,
    [financialYear],
  )) as any[]

  const [totals] = (await query<any[]>(
    `SELECT ${totalsSelect()} FROM finance_gst_input WHERE financial_year = ?`,
    [financialYear],
  )) as any[]

  return { financialYear, totals: totals as ItcTotals, byQuarter, byMonth }
}

/** Distinct financial years present in the register (newest first). */
export async function gstInputFinancialYears(): Promise<string[]> {
  await ensureGstInputSchema()
  const rows = (await query<any[]>(
    `SELECT DISTINCT financial_year v FROM finance_gst_input
       WHERE financial_year IS NOT NULL AND financial_year <> '' ORDER BY v DESC`,
  )) as any[]
  return rows.map((r) => r.v)
}

const norm = (s: any) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, "")

/**
 * Phase 17/18 — reconcile the purchase register against GSTR-2B for a period.
 * Matches on supplier GSTIN + bill number; a tax variance within ₹2 is treated
 * as a match, anything else is a mismatch. Persists the per-record status +
 * variance and returns the two-sided report (books vs 2B, and 2B-only lines the
 * books are missing).
 */
export async function reconcilePeriod(period: string) {
  await ensureGstInputSchema()

  const books = await listGstInput({ period })
  const twoB = (await query<any[]>(`SELECT * FROM finance_gstr2b WHERE period = ?`, [period])) as any[]

  const twoBByKey = new Map<string, any>()
  for (const r of twoB) twoBByKey.set(`${norm(r.supplier_gstin)}|${norm(r.bill_number)}`, r)
  const matchedTwoBIds = new Set<number>()

  for (const rec of books) {
    const key = `${norm(rec.vendor_gstin)}|${norm(rec.bill_number)}`
    const hit = twoBByKey.get(key)
    let statusValue = "Not in 2B"
    let ref: string | null = null
    let g2bTaxable: number | null = null
    let g2bTax: number | null = null
    let variance: number | null = null

    if (hit) {
      matchedTwoBIds.add(hit.id)
      const bookTax = round2(num(rec.total_gst))
      const twoBTax = round2(
        num(hit.total_tax) || num(hit.cgst_amount) + num(hit.sgst_amount) + num(hit.igst_amount) + num(hit.cess_amount),
      )
      variance = round2(bookTax - twoBTax)
      ref = hit.bill_number || String(hit.id)
      g2bTaxable = round2(num(hit.taxable_amount))
      g2bTax = twoBTax
      statusValue = Math.abs(variance) <= 2 ? "Matched" : "Mismatch"
    }

    await query(
      `UPDATE finance_gst_input
          SET reconciliation_status = ?, gstr2b_reference = ?, gstr2b_taxable = ?, gstr2b_tax = ?, match_variance = ?
        WHERE id = ?`,
      [statusValue, ref, g2bTaxable, g2bTax, variance, rec.id],
    )
  }

  const onlyInTwoB = twoB.filter((r) => !matchedTwoBIds.has(r.id))

  const refreshed = await listGstInput({ period })
  const tally = { matched: 0, mismatch: 0, notIn2b: 0, onlyIn2b: onlyInTwoB.length }
  for (const r of refreshed) {
    if (r.reconciliation_status === "Matched") tally.matched++
    else if (r.reconciliation_status === "Mismatch") tally.mismatch++
    else if (r.reconciliation_status === "Not in 2B") tally.notIn2b++
  }

  return { period, tally, books: refreshed, onlyInTwoB }
}

/**
 * Draft a GSTR-2B for a period from the bills themselves (a stand-in for the
 * real GSTN download) so reconciliation has a counter-set to match against.
 * Rebuilds the draft rows for the period each run; never touches uploaded rows.
 */
export async function draftGstr2bFromBills(period: string) {
  await ensureGstInputSchema()
  await query(`DELETE FROM finance_gstr2b WHERE period = ? AND source = 'Draft'`, [period])
  const books = await listGstInput({ period })
  for (const r of books) {
    await query(
      `INSERT INTO finance_gstr2b
         (period, supplier_gstin, supplier_name, bill_number, bill_date, taxable_amount,
          cgst_amount, sgst_amount, igst_amount, cess_amount, total_tax, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'Draft')`,
      [
        period, r.vendor_gstin, r.vendor_name, r.bill_number, r.bill_date, round2(num(r.taxable_amount)),
        round2(num(r.cgst_amount)), round2(num(r.sgst_amount)), round2(num(r.igst_amount)),
        round2(num(r.cess_amount)), round2(num(r.total_gst)),
      ],
    )
  }
  return { period, drafted: books.length }
}

export type TaxException = {
  expense_id: string
  expense_date: string | null
  party: string
  type: string
  severity: "error" | "warning"
  message: string
}

/**
 * Phase 37 — surface tax exceptions on the Expense ledger for a period so a
 * preparer can fix them before filing. Read-only: it never mutates the ledger,
 * it derives issues from the frozen expense snapshot + the projected GST Input
 * register (missing GSTIN/PAN, wrong/absent TDS section, ITC vs 2B mismatch,
 * self-inconsistent tax, and duplicate GST Input keys).
 */
export async function detectTaxExceptions(period: string): Promise<TaxException[]> {
  await ensureGstInputSchema()
  const from = `${period}-01`
  const rows = (await query<any[]>(
    `SELECT * FROM expenses WHERE expense_date >= ? AND expense_date <= LAST_DAY(?)
      AND COALESCE(approval_status,'') NOT IN ('Rejected','Cancelled')`,
    [from, from],
  )) as any[]

  const out: TaxException[] = []
  const push = (r: any, type: string, severity: "error" | "warning", message: string) =>
    out.push({
      expense_id: r.expense_id,
      expense_date: r.expense_date ? String(r.expense_date).slice(0, 10) : null,
      party: r.vendor_name || r.employee_name || r.party_name || "—",
      type,
      severity,
      message,
    })

  for (const r of rows) {
    const isVendor = !!norm(r.vendor_id) || !!norm(r.vendor_name)
    const gstApplicable = !!num(r.gst_applicable)
    const gstTotal = round2(num(r.cgst_amount) + num(r.sgst_amount) + num(r.igst_amount) + num(r.cess_amount))

    // Missing GSTIN on a GST-bearing vendor expense (Phase 37 / 33).
    if (gstApplicable && gstTotal > 0 && isVendor && !norm(r.vendor_gstin))
      push(r, "Missing GSTIN", "warning", "Input GST claimed but the vendor GSTIN is blank.")

    // Contradictory tax components (Phase 4) — intra-state must not carry IGST
    // and inter-state must not carry CGST/SGST.
    const inter = norm(r.supply_type) === "Inter-State"
    if (gstApplicable) {
      if (inter && (num(r.cgst_amount) > 0 || num(r.sgst_amount) > 0))
        push(r, "Wrong GST", "error", "Inter-State supply carries CGST/SGST instead of IGST.")
      if (!inter && norm(r.supply_type) === "Intra-State" && num(r.igst_amount) > 0)
        push(r, "Wrong GST", "error", "Intra-State supply carries IGST instead of CGST/SGST.")
    }

    // TDS applied without a section, or a TDS-flagged vendor expense with no TDS.
    if (num(r.tds_applicable) && num(r.tds_amount) > 0 && !norm(r.tds_section))
      push(r, "Missing TDS Section", "error", "TDS deducted but no statutory section is set.")
    if (isVendor && norm(r.tds_section) && !num(r.tds_amount))
      push(r, "Missing TDS", "warning", "A TDS section is set but no TDS was deducted.")

    // Missing PAN where TDS applies (Phase 32) — a 20% higher rate risk.
    if (num(r.tds_applicable) && num(r.tds_amount) > 0 && isVendor && !norm(r.vendor_pan))
      push(r, "Missing PAN", "warning", "TDS deducted but the vendor PAN is blank (higher-rate risk).")
  }

  // ITC vs GSTR-2B mismatch + duplicate GST Input keys (Phase 37 / 14 / 12).
  const gin = (await query<any[]>(
    `SELECT source_bill_ref, vendor_name, employee_name, reconciliation_status, source, source_bill_id
       FROM finance_gst_input WHERE source = 'Expense' AND period = ?`,
    [period],
  )) as any[]
  const seen = new Map<string, number>()
  for (const g of gin) {
    if (g.reconciliation_status === "Mismatch")
      out.push({
        expense_id: g.source_bill_ref,
        expense_date: null,
        party: g.vendor_name || g.employee_name || "—",
        type: "2B Mismatch",
        severity: "warning",
        message: "GST Input tax does not match GSTR-2B for this expense.",
      })
    const key = `${g.source}|${g.source_bill_id}`
    seen.set(key, (seen.get(key) || 0) + 1)
  }
  for (const [key, count] of seen) {
    if (count > 1)
      out.push({
        expense_id: key.split("|")[1],
        expense_date: null,
        party: "—",
        type: "Duplicate GST Input",
        severity: "error",
        message: `${count} GST Input records share the same source key.`,
      })
  }

  return out
}

/** Mark a set of register rows as claimed / unclaimed in a period. */
export async function setClaimState(ids: number[], claimed: boolean, period: string | null) {
  await ensureGstInputSchema()
  if (!ids.length) return { updated: 0 }
  const placeholders = ids.map(() => "?").join(",")
  // Only eligible credits can be claimed; ineligible rows are left untouched.
  await query(
    `UPDATE finance_gst_input
        SET itc_claimed = ?, claimed_period = ?,
            status = CASE
              WHEN itc_eligible = 0 THEN 'Ineligible'
              WHEN ? = 1 THEN 'Claimed'
              WHEN itc_reversal_amount > 0 AND itc_net <= 0 THEN 'Reversed'
              ELSE 'Available' END
      WHERE id IN (${placeholders}) AND itc_eligible = 1`,
    [claimed ? 1 : 0, claimed ? period : null, claimed ? 1 : 0, ...ids],
  )
  return { updated: ids.length }
}
