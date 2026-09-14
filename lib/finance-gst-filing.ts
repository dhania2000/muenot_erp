import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { logFinanceEvent } from "@/lib/finance-audit"
import { ensureGstInputSchema } from "@/lib/finance-ensure"
import { ensureGstPaymentAccounts } from "@/lib/finance-accounts"
import { postLines, type PostingLine } from "@/lib/finance-posting"

/**
 * GST filing engine (server-only) — Phase 3.
 *
 * GST returns are DERIVED from the posted sales-invoice ledger, never typed by
 * hand (spec 120–125). For a tax period (a calendar month, GST's return unit)
 * this builds a GSTR-1-style outward-supply summary:
 *
 *   - document totals (taxable / CGST / SGST / IGST / cess), with credit notes
 *     shown separately as reductions,
 *   - a rate-wise breakup from the invoice line items, and
 *   - an intra- vs inter-state split.
 *
 * Only Issued / Sent / Posted tax documents are included; Proforma invoices are
 * excluded (spec 220). A filing can be locked for a period, and a locked period
 * cannot be filed twice (duplicate prevention, spec 122).
 *
 * Schema is self-creating + idempotent. The engine owns a DEDICATED
 * `gst_return_filings` table. It must NOT reuse the name `gst_filings`: the
 * finance migrations ship an unrelated, differently-shaped `gst_filings`
 * register (columns like `return_period` / `filing_status`, and no `period` /
 * `status` / `filing_id`). When both existed, `CREATE TABLE IF NOT EXISTS`
 * no-oped against the migration table and the engine's `WHERE period = ?`
 * lookups threw "Unknown column 'period'", which blanked the entire GST page.
 */

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

let ensured = false

// MySQL has no "ADD COLUMN IF NOT EXISTS", so probe information_schema first.
async function ensureColumn(table: string, column: string, definition: string) {
  const rows = (await query(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  ).catch(() => [])) as any[]
  if (rows.length === 0) {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`).catch(() => {})
  }
}

export async function ensureGstFilingSchema() {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS gst_return_filings (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      filing_id VARCHAR(40) NOT NULL,
      return_type VARCHAR(20) NOT NULL DEFAULT 'GSTR-1',
      period VARCHAR(7) NOT NULL,               -- YYYY-MM
      financial_year VARCHAR(12) DEFAULT NULL,
      invoice_count INT NOT NULL DEFAULT 0,
      total_taxable DECIMAL(16,2) NOT NULL DEFAULT 0,
      total_cgst DECIMAL(16,2) NOT NULL DEFAULT 0,
      total_sgst DECIMAL(16,2) NOT NULL DEFAULT 0,
      total_igst DECIMAL(16,2) NOT NULL DEFAULT 0,
      total_cess DECIMAL(16,2) NOT NULL DEFAULT 0,
      total_tax DECIMAL(16,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'Filed',   -- Filed | Amended
      arn VARCHAR(40) DEFAULT NULL,
      snapshot LONGTEXT DEFAULT NULL,
      filed_at TIMESTAMP NULL DEFAULT NULL,
      filed_by BIGINT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_gst_return_period (return_type, period),
      UNIQUE KEY uq_gst_filing_id (filing_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Per-period cash-ledger challan: the GST actually paid for a tax period
  // (GSTR-3B / PMT-06). One row per period; the dashboard's Balance Payable is
  // Net GST Liability minus this. Self-creating + idempotent like the rest.
  await query(
    `CREATE TABLE IF NOT EXISTS gst_tax_payments (
      period VARCHAR(7) NOT NULL PRIMARY KEY,          -- YYYY-MM
      amount DECIMAL(16,2) NOT NULL DEFAULT 0,
      note VARCHAR(255) DEFAULT NULL,
      updated_by BIGINT UNSIGNED DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ).catch(() => {})

  // One-time rescue: earlier builds of this engine wrote filing-lock rows into a
  // table literally named `gst_filings`, which now collides with the unrelated
  // GST register shipped in the finance migrations. If this DB still holds
  // engine-shaped rows there (detected by the engine-only `period` column), copy
  // them into the dedicated table so filed history survives. On DBs where
  // `gst_filings` is the migration register (no `period` column) this is a no-op.
  const legacyEngine = (await query(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gst_filings' AND COLUMN_NAME = 'period'`,
  ).catch(() => [])) as any[]
  if (legacyEngine.length) {
    await query(
      `INSERT IGNORE INTO gst_return_filings
         (filing_id, return_type, period, financial_year, invoice_count, total_taxable,
          total_cgst, total_sgst, total_igst, total_cess, total_tax, status, arn, snapshot, filed_at, filed_by, created_at)
       SELECT filing_id, return_type, period, financial_year, invoice_count, total_taxable,
          total_cgst, total_sgst, total_igst, total_cess, total_tax, status, arn, snapshot, filed_at, filed_by, created_at
         FROM gst_filings`,
    ).catch(() => {})
  }

  // Phase 15 — enrich the filing record with the ITC + Net Liability figures and
  // the human who filed, without a new table. Older DBs get them added in place.
  await ensureColumn("gst_return_filings", "total_itc", "DECIMAL(16,2) NOT NULL DEFAULT 0")
  await ensureColumn("gst_return_filings", "net_liability", "DECIMAL(16,2) NOT NULL DEFAULT 0")
  await ensureColumn("gst_return_filings", "filed_by_name", "VARCHAR(190) DEFAULT NULL")

  // Phase 16 — Nil returns are ordinary filing rows flagged as Nil, so the whole
  // status workflow, lock and amendment path apply to them unchanged.
  await ensureColumn("gst_return_filings", "is_nil", "TINYINT(1) NOT NULL DEFAULT 0")
  // Phase 14 — how many times a filed period has been amended (0 = original).
  await ensureColumn("gst_return_filings", "revision", "INT NOT NULL DEFAULT 0")

  // Phase 11 — cash-ledger challan → Journal/GL linkage. The payment is posted to
  // a real balanced voucher; these columns key that posting so it is idempotent
  // (never double-posts) and can be reversed/re-posted when the amount or mode
  // changes — exactly like the purchase-bill posting sync.
  await ensureColumn("gst_tax_payments", "payment_mode", "VARCHAR(10) NOT NULL DEFAULT 'bank'")
  await ensureColumn("gst_tax_payments", "paid_on", "DATE DEFAULT NULL")
  await ensureColumn("gst_tax_payments", "voucher_no", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn("gst_tax_payments", "reversal_voucher_no", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn("gst_tax_payments", "posted_amount", "DECIMAL(16,2) NOT NULL DEFAULT 0")
  await ensureColumn("gst_tax_payments", "posted_mode", "VARCHAR(10) DEFAULT NULL")
  await ensureColumn("gst_tax_payments", "posting_status", "VARCHAR(20) NOT NULL DEFAULT 'Unposted'")

  // Phase 14 — amendment audit trail. Filing a return LOCKS the period; a
  // correction never silently overwrites the filed figures. Instead the current
  // filed snapshot is archived here before the amended snapshot replaces it, so
  // the original return is always recoverable.
  await query(
    `CREATE TABLE IF NOT EXISTS gst_return_amendments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      filing_id VARCHAR(40) NOT NULL,
      period VARCHAR(7) NOT NULL,
      revision INT NOT NULL DEFAULT 1,
      previous_status VARCHAR(20) DEFAULT NULL,
      previous_arn VARCHAR(40) DEFAULT NULL,
      previous_total_taxable DECIMAL(16,2) NOT NULL DEFAULT 0,
      previous_total_tax DECIMAL(16,2) NOT NULL DEFAULT 0,
      previous_snapshot LONGTEXT DEFAULT NULL,
      reason VARCHAR(255) DEFAULT NULL,
      amended_by BIGINT UNSIGNED DEFAULT NULL,
      amended_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_gst_amend_period (period)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ).catch(() => {})

  ensured = true
}

// ── Return-status workflow (Phase 13/14) ────────────────────────────────────
// A period's GSTR-1 moves through a controlled lifecycle. Everything at or after
// "Filed" is LOCKED for normal editing; the only sanctioned change afterwards is
// a tracked amendment.
export const GST_RETURN_STATUSES = [
  "Not Prepared",
  "Draft",
  "Ready for Review",
  "Reviewed",
  "Filed",
  "Amended",
  "Payment Pending",
  "Completed",
] as const
export type GstReturnStatus = (typeof GST_RETURN_STATUSES)[number]

const LOCKED_STATUSES = new Set<GstReturnStatus>(["Filed", "Amended", "Payment Pending", "Completed"])
const PRE_FILE_STATUSES = new Set<GstReturnStatus>(["Not Prepared", "Draft", "Ready for Review", "Reviewed"])

function isLocked(status: string | null | undefined): boolean {
  return LOCKED_STATUSES.has(String(status || "Not Prepared") as GstReturnStatus)
}

/** The actions the UI may offer for a given current status (Phase 13). */
export function availableActions(status: string): string[] {
  switch (status) {
    case "Not Prepared":
      return ["prepare", "file"]
    case "Draft":
      return ["submit-review", "file"]
    case "Ready for Review":
      return ["review", "reopen", "file"]
    case "Reviewed":
      return ["file", "reopen"]
    case "Filed":
      return ["mark-payment-pending", "complete", "amend"]
    case "Payment Pending":
      return ["complete", "amend"]
    case "Completed":
      return ["amend"]
    case "Amended":
      return ["mark-payment-pending", "complete", "amend"]
    default:
      return []
  }
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

function periodRange(period: string) {
  if (!PERIOD_RE.test(period)) throw new Error("Period must be in YYYY-MM format.")
  const [y, m] = period.split("-").map(Number)
  const from = `${period}-01`
  const last = new Date(y, m, 0).getDate()
  const to = `${period}-${String(last).padStart(2, "0")}`
  // y/m drive the actual row matching (see PERIOD_MATCH). We match on the
  // YEAR()/MONTH() of invoice_date — exactly like the Sales Invoice list — so
  // the GST module always agrees with the invoices the user can see, no matter
  // how invoice_date is physically stored (DATE, DATETIME, or ISO string).
  return { from, to, y, m }
}

// Format-agnostic month match used by every period-scoped GST query.
const PERIOD_MATCH = (col: string) => `YEAR(${col}) = ? AND MONTH(${col}) = ?`

// A tax document belongs in the GST return the moment it leaves Draft. We
// exclude ONLY Draft (not a real document yet) and Cancelled (voided), so every
// issued invoice for the period flows into GSTR-1 automatically — including
// invoices whose GST works out to ₹0 (exempt / nil-rated / unregistered).
const INCLUDED_STATUS = "NOT IN ('Draft','Cancelled')"

/** FY quarter label (Apr–Jun = Q1) for a calendar month 1..12. */
function quarterLabel(m: number) {
  const q = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 && m <= 12 ? 3 : 4
  return `Q${q}`
}

/**
 * Input-side aggregates for a period, read from the shared GST Input (ITC)
 * register that Purchase Bills + Expenses already project into. We do NOT
 * recompute ITC here — we only sum the register so GST Filing and GST Input
 * always agree. Safe when the register is empty / not yet created.
 */
async function gstInputAggregates(period: string) {
  const empty = {
    input_net: 0,
    input_gross: 0,
    eligible: 0,
    reversal: 0,
    itc_cgst: 0,
    itc_sgst: 0,
    itc_igst: 0,
    itc_cess: 0,
    rcm: 0,
  }
  try {
    await ensureGstInputSchema()
    const [row] = (await query(
      `SELECT COALESCE(SUM(itc_net),0) AS input_net,
              COALESCE(SUM(itc_gross),0) AS input_gross,
              COALESCE(SUM(itc_eligible_amount),0) AS eligible,
              COALESCE(SUM(itc_reversal_amount),0) AS reversal,
              COALESCE(SUM(itc_cgst),0) AS itc_cgst,
              COALESCE(SUM(itc_sgst),0) AS itc_sgst,
              COALESCE(SUM(itc_igst),0) AS itc_igst,
              COALESCE(SUM(itc_cess),0) AS itc_cess,
              COALESCE(SUM(CASE WHEN rcm_applicable = 1 THEN total_gst ELSE 0 END),0) AS rcm
         FROM finance_gst_input WHERE period = ?`,
      [period],
    ).catch(() => [{}])) as any[]
    return {
      input_net: round2(num(row?.input_net)),
      input_gross: round2(num(row?.input_gross)),
      eligible: round2(num(row?.eligible)),
      reversal: round2(num(row?.reversal)),
      itc_cgst: round2(num(row?.itc_cgst)),
      itc_sgst: round2(num(row?.itc_sgst)),
      itc_igst: round2(num(row?.itc_igst)),
      itc_cess: round2(num(row?.itc_cess)),
      rcm: round2(num(row?.rcm)),
    }
  } catch {
    return empty
  }
}

/** The GST actually paid (cash-ledger challan) recorded for a period. */
export async function getGstTaxPaid(period: string): Promise<number> {
  await ensureGstFilingSchema()
  const [row] = (await query(
    `SELECT amount FROM gst_tax_payments WHERE period = ? LIMIT 1`,
    [period],
  ).catch(() => [])) as any[]
  return round2(num(row?.amount))
}

/** The balanced lines for a GST cash payment (Phase 11):
 *    Dr GST Payable (net liability settled)
 *    Cr Bank / Cash
 *  Posting this against the dedicated 2160 head keeps the payment off the
 *  per-head output-tax accounts the sales invoices already own, so no accounting
 *  entry is duplicated. */
function gstPaymentLines(amount: number, mode: "bank" | "cash"): PostingLine[] {
  const value = round2(amount)
  return [
    { role: "gst_payable", debit: value, credit: 0, gst: value },
    { role: mode === "cash" ? "cash" : "bank", debit: 0, credit: value },
  ]
}

/**
 * Keep a period's GST payment posting in sync with the recorded cash-ledger
 * amount — idempotently, like the purchase-bill posting sync:
 *   - amount 0            → reverse any prior voucher, leave nothing posted
 *   - unchanged amount    → no-op (never double-posts)
 *   - changed amount/mode → reverse the old voucher, post a fresh one
 *   - not yet posted      → post and stamp the voucher back onto the row
 * Failures never block the challan record; they surface as an Unposted state.
 */
async function syncGstPaymentPosting(
  period: string,
  actorId?: number | null,
): Promise<{ action: "posted" | "reposted" | "reversed" | "skipped" | "error"; voucherNo?: string | null }> {
  const [row] = (await query(
    `SELECT * FROM gst_tax_payments WHERE period = ? LIMIT 1`,
    [period],
  ).catch(() => [])) as any[]
  if (!row) return { action: "skipped", voucherNo: null }

  const amount = round2(num(row.amount))
  const mode: "bank" | "cash" = String(row.payment_mode) === "cash" ? "cash" : "bank"
  const date = row.paid_on ? String(row.paid_on).slice(0, 10) : new Date().toISOString().slice(0, 10)
  const fy = financialYearFor(`${period}-01`)
  const existingVoucher = row.voucher_no ? String(row.voucher_no) : null
  const postedAmount = round2(num(row.posted_amount))
  const postedMode: "bank" | "cash" = String(row.posted_mode) === "cash" ? "cash" : "bank"

  const postArgs = (narration: string) => ({
    entityType: "gst_payment",
    entityId: 0,
    entityRef: `GST-PAY:${period}`,
    date,
    financialYear: fy,
    voucherType: "Payment",
    narration,
    sourceModule: "GST Filing",
    createdBy: actorId ?? null,
  })

  const reverseExisting = async () => {
    if (!existingVoucher || postedAmount <= 0) return
    await postLines(gstPaymentLines(postedAmount, postedMode), {
      ...postArgs(`Reversal of GST payment for ${period}`),
      reverse: true,
    })
    await query(
      `UPDATE gst_tax_payments
          SET reversal_voucher_no = ?, voucher_no = NULL, posted_amount = 0, posted_mode = NULL, posting_status = 'Unposted'
        WHERE period = ?`,
      [existingVoucher, period],
    )
  }

  try {
    await ensureGstPaymentAccounts()

    if (amount <= 0) {
      if (existingVoucher) {
        await reverseExisting()
        return { action: "reversed", voucherNo: null }
      }
      return { action: "skipped", voucherNo: null }
    }

    if (existingVoucher && Math.abs(postedAmount - amount) <= 0.01 && postedMode === mode) {
      return { action: "skipped", voucherNo: existingVoucher }
    }

    let reposted = false
    if (existingVoucher) {
      await reverseExisting()
      reposted = true
    }

    const result = await postLines(
      gstPaymentLines(amount, mode),
      postArgs(`GST payment for ${period} (${mode === "cash" ? "Cash" : "Bank"})`),
    )
    await query(
      `UPDATE gst_tax_payments
          SET voucher_no = ?, posted_amount = ?, posted_mode = ?, posting_status = 'Posted'
        WHERE period = ?`,
      [result.voucherNo, amount, mode, period],
    )
    return { action: reposted ? "reposted" : "posted", voucherNo: result.voucherNo }
  } catch (error) {
    console.log("[v0] GST payment posting failed for", period, (error as Error)?.message)
    await query(`UPDATE gst_tax_payments SET posting_status = 'Unposted' WHERE period = ?`, [period]).catch(() => {})
    return { action: "error", voucherNo: existingVoucher }
  }
}

/** Read the payment posting linkage for a period (voucher + posting state). */
async function getGstPaymentPosting(period: string) {
  const [row] = (await query(
    `SELECT amount, payment_mode, paid_on, voucher_no, posting_status FROM gst_tax_payments WHERE period = ? LIMIT 1`,
    [period],
  ).catch(() => [])) as any[]
  if (!row) return { amount: 0, mode: "bank", paid_on: null, voucher_no: null, posting_status: "Unposted" }
  return {
    amount: round2(num(row.amount)),
    mode: String(row.payment_mode) === "cash" ? "cash" : "bank",
    paid_on: row.paid_on ? String(row.paid_on).slice(0, 10) : null,
    voucher_no: row.voucher_no ? String(row.voucher_no) : null,
    posting_status: String(row.posting_status || "Unposted"),
  }
}

/**
 * Record (upsert) the GST paid for a period, then reconcile its Journal/GL
 * posting. Idempotent per period (Phase 11).
 */
export async function recordGstTaxPaid(
  period: string,
  amount: number,
  actorId?: number | null,
  opts: { mode?: "bank" | "cash"; paidOn?: string } = {},
) {
  await ensureGstFilingSchema()
  if (!PERIOD_RE.test(period)) throw new Error("Period must be in YYYY-MM format.")
  const value = round2(Math.max(num(amount), 0))
  const mode: "bank" | "cash" = opts.mode === "cash" ? "cash" : "bank"
  const paidOn =
    opts.paidOn && /^\d{4}-\d{2}-\d{2}$/.test(opts.paidOn) ? opts.paidOn : new Date().toISOString().slice(0, 10)
  await query(
    `INSERT INTO gst_tax_payments (period, amount, payment_mode, paid_on, updated_by)
       VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE amount = VALUES(amount), payment_mode = VALUES(payment_mode),
       paid_on = VALUES(paid_on), updated_by = VALUES(updated_by)`,
    [period, value, mode, paidOn, actorId ?? null],
  )
  const posting = await syncGstPaymentPosting(period, actorId)
  await logFinanceEvent({
    entityType: "gst_filing",
    entityRef: `TAX-PAID:${period}`,
    type: "updated",
    summary: `GST tax paid recorded for ${period}: ${value} (${mode})${posting.voucherNo ? ` → ${posting.voucherNo}` : ""}`,
    amount: value,
    actorId: actorId ?? null,
  }).catch(() => {})
  return { period, amount: value, mode, voucher_no: posting.voucherNo ?? null, posting: posting.action }
}

/** Build the GSTR-1 outward-supply summary for a calendar-month period. */
export async function gstSummary(period: string) {
  await ensureGstFilingSchema()
  const { from, to, y, m } = periodRange(period)

  const [totals] = (await query(
    `SELECT
        COUNT(*) AS invoice_count,
        COALESCE(SUM(CASE WHEN invoice_type='Credit Note' THEN 0 ELSE taxable_amount END),0) AS taxable,
        COALESCE(SUM(CASE WHEN invoice_type='Credit Note' THEN 0 ELSE cgst_amount END),0) AS cgst,
        COALESCE(SUM(CASE WHEN invoice_type='Credit Note' THEN 0 ELSE sgst_amount END),0) AS sgst,
        COALESCE(SUM(CASE WHEN invoice_type='Credit Note' THEN 0 ELSE igst_amount END),0) AS igst,
        COALESCE(SUM(CASE WHEN invoice_type='Credit Note' THEN 0 ELSE other_tax_cess END),0) AS cess,
        COALESCE(SUM(CASE WHEN invoice_type='Credit Note' THEN taxable_amount ELSE 0 END),0) AS cn_taxable,
        COALESCE(SUM(CASE WHEN invoice_type='Credit Note' THEN (cgst_amount+sgst_amount+igst_amount+other_tax_cess) ELSE 0 END),0) AS cn_tax,
        COALESCE(SUM(CASE WHEN invoice_type='Debit Note' THEN taxable_amount ELSE 0 END),0) AS dn_taxable,
        COALESCE(SUM(CASE WHEN invoice_type='Debit Note' THEN (cgst_amount+sgst_amount+igst_amount+other_tax_cess) ELSE 0 END),0) AS dn_tax,
        COALESCE(SUM(CASE WHEN invoice_type='Credit Note' THEN 1 ELSE 0 END),0) AS cn_count,
        COALESCE(SUM(CASE WHEN invoice_type='Debit Note' THEN 1 ELSE 0 END),0) AS dn_count
      FROM sales_invoices
     WHERE ${PERIOD_MATCH("invoice_date")}
       AND invoice_status ${INCLUDED_STATUS}
       AND invoice_type <> 'Proforma Invoice'`,
    [y, m],
  ).catch(() => [{}])) as any[]

  const rateWise = (await query(
    `SELECT it.tax_rate AS rate,
            COALESCE(SUM(it.taxable_value),0) AS taxable,
            COALESCE(SUM(it.cgst_amount),0) AS cgst,
            COALESCE(SUM(it.sgst_amount),0) AS sgst,
            COALESCE(SUM(it.igst_amount),0) AS igst,
            COALESCE(SUM(it.cess_amount),0) AS cess
       FROM sales_invoice_items it
       JOIN sales_invoices si ON si.id = it.invoice_pk
      WHERE ${PERIOD_MATCH("si.invoice_date")}
        AND si.invoice_status ${INCLUDED_STATUS}
        AND si.invoice_type NOT IN ('Proforma Invoice','Credit Note')
      GROUP BY it.tax_rate
      ORDER BY it.tax_rate ASC`,
    [y, m],
  ).catch(() => [])) as any[]

  const supply = (await query(
    `SELECT COALESCE(supply_type,'Intra-State') AS supply_type,
            COALESCE(SUM(taxable_amount),0) AS taxable,
            COALESCE(SUM(cgst_amount+sgst_amount+igst_amount+other_tax_cess),0) AS tax
       FROM sales_invoices
      WHERE ${PERIOD_MATCH("invoice_date")}
        AND invoice_status ${INCLUDED_STATUS}
        AND invoice_type NOT IN ('Proforma Invoice','Credit Note')
      GROUP BY COALESCE(supply_type,'Intra-State')`,
    [y, m],
  ).catch(() => [])) as any[]

  // Diagnostics: invoices that fall in the period but are excluded from the
  // return, so the UI can explain an empty summary ("1 Draft not included")
  // instead of silently showing zeros.
  const [diag] = (await query(
    `SELECT
        COUNT(*) AS in_period,
        COALESCE(SUM(CASE WHEN invoice_status = 'Draft' THEN 1 ELSE 0 END),0) AS draft,
        COALESCE(SUM(CASE WHEN invoice_status = 'Cancelled' THEN 1 ELSE 0 END),0) AS cancelled,
        COALESCE(SUM(CASE WHEN invoice_type = 'Proforma Invoice' THEN 1 ELSE 0 END),0) AS proforma
      FROM sales_invoices
     WHERE ${PERIOD_MATCH("invoice_date")}`,
    [y, m],
  ).catch(() => [{}])) as any[]

  const taxable = round2(num(totals?.taxable))
  const cgst = round2(num(totals?.cgst))
  const sgst = round2(num(totals?.sgst))
  const igst = round2(num(totals?.igst))
  const cess = round2(num(totals?.cess))
  const totalTax = round2(cgst + sgst + igst + cess)

  // Invoice-level detail (document register) for the period — every non-Draft
  // tax document that feeds the return, with the client's GSTIN pulled from the
  // clients master so the UI can show "Client GST + Invoice Details" per row.
  const invoices = (await query(
    `SELECT si.invoice_id,
            si.invoice_date,
            si.invoice_type,
            si.client_name,
            si.project_name,
            si.place_of_supply,
            COALESCE(si.supply_type,'Intra-State') AS supply_type,
            si.invoice_status,
            COALESCE(c.gst_number,'') AS client_gstin,
            COALESCE(NULLIF(c.legal_name,''), NULLIF(c.company_name,''), si.client_name) AS client_legal_name,
            si.taxable_amount,
            si.cgst_amount,
            si.sgst_amount,
            si.igst_amount,
            si.other_tax_cess AS cess_amount,
            si.invoice_total
       FROM sales_invoices si
       LEFT JOIN clients c ON c.id = si.client_id OR c.client_code = si.client_id
      WHERE ${PERIOD_MATCH("si.invoice_date")}
        AND si.invoice_status ${INCLUDED_STATUS}
        AND si.invoice_type <> 'Proforma Invoice'
      ORDER BY si.invoice_date ASC, si.invoice_id ASC`,
    [y, m],
  ).catch(() => [])) as any[]

  const [existing] = (await query(
    `SELECT * FROM gst_return_filings WHERE return_type = 'GSTR-1' AND period = ? LIMIT 1`,
    [period],
  )) as any[]

  // ── Compliance liability (Phase 1) ──────────────────────────────────────
  // Output GST is the outward tax NET of credit notes (debit notes already add
  // to the output totals above, since only Credit Note is zeroed there). Input
  // GST, RCM and reversal come straight from the shared ITC register so the two
  // GST screens never disagree. RCM tax is a liability on the output side AND a
  // claimable credit on the input side — the standard offset nets it to zero
  // when fully eligible, so we surface both without double counting.
  const creditNoteTax = round2(num(totals?.cn_tax))
  const debitNoteTax = round2(num(totals?.dn_tax))
  const agg = await gstInputAggregates(period)
  const payment = await getGstPaymentPosting(period)
  const taxPaid = payment.amount
  const outputGst = round2(totalTax - creditNoteTax)
  const netLiability = round2(outputGst + agg.rcm - agg.input_net)
  const balancePayable = round2(netLiability - taxPaid)

  // ── Return status (Phase 13/14) ─────────────────────────────────────────
  // No filing row → the return has not been started ("Not Prepared"). Once a row
  // exists its stored status governs the lifecycle and the lock.
  const status: string = existing ? String(existing.status || "Filed") : "Not Prepared"
  const locked = isLocked(status)
  const [amendCount] = (await query(
    `SELECT COUNT(*) AS n FROM gst_return_amendments WHERE period = ?`,
    [period],
  ).catch(() => [{ n: 0 }])) as any[]

  // ── Nil-return eligibility (Phase 16) ────────────────────────────────────
  // A Nil GSTR-1/3B is offered only when the period is genuinely empty on every
  // applicable dimension: no outward documents, no inward ITC, and no residual
  // liability. The reasons list every non-zero dimension so the UI can explain
  // why Nil is unavailable instead of silently hiding the option.
  const nilReasons: string[] = []
  if (Number(totals?.invoice_count ?? 0) > 0)
    nilReasons.push(`${Number(totals?.invoice_count ?? 0)} outward document(s) in the period`)
  if (agg.input_gross > 0) nilReasons.push("inward ITC is present in the GST Input register")
  if (round2(netLiability) > 0) nilReasons.push("a net GST liability is outstanding")
  const nilEligible = nilReasons.length === 0

  // Invoice-level rows shaped once and reused for both the document register and
  // the GSTR-1 data sections below, so the two never diverge.
  const mappedInvoices = invoices.map((r) => {
    const taxableAmt = round2(num(r.taxable_amount))
    const cgstAmt = round2(num(r.cgst_amount))
    const sgstAmt = round2(num(r.sgst_amount))
    const igstAmt = round2(num(r.igst_amount))
    const cessAmt = round2(num(r.cess_amount))
    const taxTotal = round2(cgstAmt + sgstAmt + igstAmt)
    // Effective GST rate derived from the document's own tax vs taxable value,
    // so a nil / exempt invoice reports 0% instead of a blank.
    const gstRate = taxableAmt > 0 ? Math.round((taxTotal / taxableAmt) * 100) : 0
    const gstin = r.client_gstin || ""
    return {
      invoice_id: r.invoice_id,
      invoice_date: r.invoice_date,
      invoice_type: r.invoice_type,
      client_name: r.client_name || "—",
      client_legal_name: r.client_legal_name || r.client_name || "—",
      client_gstin: gstin,
      // GST registration status of the customer for the return.
      gst_registration: gstin ? "Registered" : "Unregistered",
      // GST type = the supply split that decides CGST+SGST vs IGST.
      gst_type: r.supply_type || "Intra-State",
      gst_rate: gstRate,
      project_name: r.project_name || "",
      place_of_supply: r.place_of_supply || "",
      supply_type: r.supply_type,
      status: r.invoice_status,
      taxable: taxableAmt,
      cgst: cgstAmt,
      sgst: sgstAmt,
      igst: igstAmt,
      cess: cessAmt,
      total: round2(num(r.invoice_total)),
    }
  })

  const sections = buildGstr1Sections(mappedInvoices)

  // ── GSTR-3B (Phase 4) ────────────────────────────────────────────────────
  // Auto-computed, NOT a re-entry screen. Outward side comes from the same
  // sales-invoice totals as GSTR-1 (net of credit notes); the ITC side is read
  // straight from the shared GST Input register (Purchase Bills + Expenses), so
  // there is no duplicate input entry. Net tax payable == the dashboard's Net
  // GST liability by construction.
  const netItc = agg.input_net
  const gstr3b = {
    outward: {
      taxable: round2(taxable - round2(num(totals?.cn_taxable))),
      cgst,
      sgst,
      igst,
      cess,
      credit_note_tax: creditNoteTax,
      net_output_tax: outputGst,
    },
    rcm_liability: agg.rcm,
    itc: {
      eligible: agg.eligible,
      cgst: agg.itc_cgst,
      sgst: agg.itc_sgst,
      igst: agg.itc_igst,
      cess: agg.itc_cess,
      reversal: agg.reversal,
      net: netItc,
    },
    net_tax_payable: netLiability,
  }

  return {
    period,
    financial_year: financialYearFor(`${period}-01`),
    quarter: quarterLabel(m),
    range: { from, to },
    liability: {
      output_gst: outputGst,
      input_gst: agg.input_net,
      rcm_liability: agg.rcm,
      itc_reversal: agg.reversal,
      net_liability: netLiability,
      tax_paid: taxPaid,
      balance_payable: balancePayable,
    },
    totals: {
      invoice_count: Number(totals?.invoice_count ?? 0),
      taxable,
      cgst,
      sgst,
      igst,
      cess,
      total_tax: totalTax,
      credit_note_taxable: round2(num(totals?.cn_taxable)),
      credit_note_tax: creditNoteTax,
      credit_note_count: Number(totals?.cn_count ?? 0),
      debit_note_taxable: round2(num(totals?.dn_taxable)),
      debit_note_tax: debitNoteTax,
      debit_note_count: Number(totals?.dn_count ?? 0),
    },
    rate_wise: rateWise.map((r) => ({
      rate: num(r.rate),
      taxable: round2(num(r.taxable)),
      cgst: round2(num(r.cgst)),
      sgst: round2(num(r.sgst)),
      igst: round2(num(r.igst)),
      cess: round2(num(r.cess)),
    })),
    supply_split: supply.map((r) => ({
      supply_type: r.supply_type,
      taxable: round2(num(r.taxable)),
      tax: round2(num(r.tax)),
    })),
    invoices: mappedInvoices,
    sections,
    gstr3b,
    excluded: {
      in_period: Number(diag?.in_period ?? 0),
      draft: Number(diag?.draft ?? 0),
      cancelled: Number(diag?.cancelled ?? 0),
      proforma: Number(diag?.proforma ?? 0),
    },
    workflow: {
      status,
      locked,
      actions: availableActions(status),
      amendment_count: Number(amendCount?.n ?? 0),
    },
    nil: {
      eligible: nilEligible,
      reasons: nilReasons,
    },
    filing: existing
      ? {
          filing_id: existing.filing_id,
          status: existing.status,
          return_type: existing.return_type,
          arn: existing.arn,
          filed_at: existing.filed_at,
          filed_by_name: existing.filed_by_name ?? null,
          is_nil: Boolean(num(existing.is_nil)),
          total_itc: round2(num(existing.total_itc)),
          net_liability: round2(num(existing.net_liability)),
        }
      : null,
  }
}

export async function listGstFilings() {
  await ensureGstFilingSchema()
  return (await query(`SELECT * FROM gst_return_filings ORDER BY period DESC, id DESC LIMIT 200`)) as any[]
}

/**
 * Lock (file) a period's GSTR-1 from the derived summary — Phase 14/15.
 *
 * The full filing record is captured: taxable + tax split, net eligible ITC, the
 * net liability and the human who filed. Filing is only permitted from a pre-file
 * status; an already-locked period rejects re-filing and must go through the
 * controlled amendment workflow instead (never a silent overwrite). A pre-file
 * Draft/Reviewed row is promoted in place so its filing_id is preserved.
 */
export async function fileGstReturn(
  period: string,
  arn: string | null,
  actorId?: number | null,
  opts: { nil?: boolean; actorName?: string | null } = {},
) {
  await ensureGstFilingSchema()
  const [existing] = (await query(
    `SELECT id, filing_id, status FROM gst_return_filings WHERE return_type = 'GSTR-1' AND period = ? LIMIT 1`,
    [period],
  )) as any[]
  if (existing && isLocked(existing.status)) {
    throw new Error(`GSTR-1 for ${period} is already ${existing.status}. Use an amendment instead.`)
  }

  const summary = await gstSummary(period)
  const nil = Boolean(opts.nil)
  if (!nil && summary.totals.invoice_count === 0) {
    throw new Error(`No tax documents found for ${period}. File a Nil return instead if the period is empty.`)
  }
  if (nil && !summary.nil.eligible) {
    throw new Error(`${period} is not eligible for a Nil return: ${summary.nil.reasons.join("; ")}.`)
  }

  const filingId = existing?.filing_id || (await nextRecordId("GST"))
  const values = filingRowValues(summary, { status: "Filed", arn, nil })

  if (existing) {
    const cols = Object.keys(values)
    await query(
      `UPDATE gst_return_filings SET ${cols.map((c) => `${c}=?`).join(",")},
         filed_at = NOW(), filed_by = ?, filed_by_name = ?
        WHERE id = ?`,
      [...cols.map((c) => values[c]), actorId ?? null, opts.actorName ?? null, existing.id],
    )
  } else {
    const cols = ["filing_id", ...Object.keys(values), "filed_at", "filed_by", "filed_by_name"]
    await query(
      `INSERT INTO gst_return_filings (${cols.join(",")})
       VALUES (?, ${Object.keys(values).map(() => "?").join(",")}, NOW(), ?, ?)`,
      [filingId, ...Object.keys(values).map((c) => values[c]), actorId ?? null, opts.actorName ?? null],
    )
  }

  await logFinanceEvent({
    entityType: "gst_filing",
    entityRef: filingId,
    type: "posted",
    summary: `GSTR-1${nil ? " (Nil)" : ""} filed for ${period}: taxable ${summary.totals.taxable}, tax ${summary.totals.total_tax}, ITC ${summary.liability.input_gst}, net ${summary.liability.net_liability}`,
    amount: summary.totals.total_tax,
    actorId: actorId ?? null,
  })
  return { filing_id: filingId, period, nil }
}

/** The persisted filing-record columns derived from a summary (Phase 15). */
function filingRowValues(
  summary: Awaited<ReturnType<typeof gstSummary>>,
  opts: { status: string; arn: string | null; nil: boolean },
): Record<string, any> {
  return {
    return_type: "GSTR-1",
    period: summary.period,
    financial_year: summary.financial_year,
    invoice_count: summary.totals.invoice_count,
    total_taxable: summary.totals.taxable,
    total_cgst: summary.totals.cgst,
    total_sgst: summary.totals.sgst,
    total_igst: summary.totals.igst,
    total_cess: summary.totals.cess,
    total_tax: summary.totals.total_tax,
    total_itc: summary.liability.input_gst,
    net_liability: summary.liability.net_liability,
    status: opts.status,
    is_nil: opts.nil ? 1 : 0,
    arn: opts.arn || null,
    snapshot: JSON.stringify(summary),
  }
}

/**
 * Move a period's return through its lifecycle (Phase 13/14). Pre-file actions
 * (prepare / submit-review / review / reopen) upsert a non-locked filing row and
 * only flip the status. `file`, `file-nil` and `amend` delegate to their
 * dedicated engines. The requested action must be legal for the current status.
 */
export async function transitionReturnStatus(
  period: string,
  action: string,
  opts: { arn?: string | null; reason?: string | null; actorId?: number | null; actorName?: string | null } = {},
) {
  await ensureGstFilingSchema()
  if (!PERIOD_RE.test(period)) throw new Error("Period must be in YYYY-MM format.")

  const [row] = (await query(
    `SELECT id, filing_id, status FROM gst_return_filings WHERE return_type = 'GSTR-1' AND period = ? LIMIT 1`,
    [period],
  )) as any[]
  const current = row ? String(row.status || "Filed") : "Not Prepared"
  if (!availableActions(current).includes(action)) {
    throw new Error(`Action "${action}" is not allowed from status "${current}".`)
  }

  if (action === "file") return fileGstReturn(period, opts.arn ?? null, opts.actorId, { actorName: opts.actorName })
  if (action === "file-nil")
    return fileGstReturn(period, opts.arn ?? null, opts.actorId, { nil: true, actorName: opts.actorName })
  if (action === "amend")
    return amendGstReturn(period, { reason: opts.reason ?? null, arn: opts.arn ?? null }, opts.actorId, opts.actorName)

  // Pre-file / post-file status-only transitions.
  const NEXT: Record<string, string> = {
    prepare: "Draft",
    "submit-review": "Ready for Review",
    review: "Reviewed",
    reopen: "Draft",
    "mark-payment-pending": "Payment Pending",
    complete: "Completed",
  }
  const target = NEXT[action]
  if (!target) throw new Error(`Unknown action "${action}".`)

  if (row) {
    await query(`UPDATE gst_return_filings SET status = ? WHERE id = ?`, [target, row.id])
  } else {
    // "prepare" from Not Prepared — materialise a Draft row from the summary.
    const summary = await gstSummary(period)
    const filingId = await nextRecordId("GST")
    const values = filingRowValues(summary, { status: target, arn: null, nil: false })
    const cols = ["filing_id", ...Object.keys(values)]
    await query(
      `INSERT INTO gst_return_filings (${cols.join(",")})
       VALUES (?, ${Object.keys(values).map(() => "?").join(",")})`,
      [filingId, ...Object.keys(values).map((c) => values[c])],
    )
  }

  await logFinanceEvent({
    entityType: "gst_filing",
    entityRef: row?.filing_id || period,
    type: "updated",
    summary: `GSTR-1 for ${period}: ${current} → ${target}`,
    actorId: opts.actorId ?? null,
  }).catch(() => {})
  return { period, status: target }
}

/**
 * Controlled amendment (Phase 14). The currently-filed snapshot is ARCHIVED into
 * gst_return_amendments before the freshly-derived figures replace it, so the
 * original return is always recoverable. The filing row's revision is bumped and
 * its status set to Amended; the filing_id is retained.
 */
export async function amendGstReturn(
  period: string,
  opts: { reason?: string | null; arn?: string | null } = {},
  actorId?: number | null,
  actorName?: string | null,
) {
  await ensureGstFilingSchema()
  const [row] = (await query(
    `SELECT * FROM gst_return_filings WHERE return_type = 'GSTR-1' AND period = ? LIMIT 1`,
    [period],
  )) as any[]
  if (!row) throw new Error(`No filed GSTR-1 exists for ${period} to amend.`)
  if (!isLocked(row.status)) throw new Error(`GSTR-1 for ${period} is not filed yet; edit the draft instead.`)

  const revision = Number(row.revision ?? 0) + 1
  await query(
    `INSERT INTO gst_return_amendments
       (filing_id, period, revision, previous_status, previous_arn, previous_total_taxable,
        previous_total_tax, previous_snapshot, reason, amended_by, amended_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
    [
      row.filing_id, period, revision, row.status, row.arn, round2(num(row.total_taxable)),
      round2(num(row.total_tax)), row.snapshot, opts.reason ?? null, actorId ?? null,
    ],
  )

  const summary = await gstSummary(period)
  const values = filingRowValues(summary, {
    status: "Amended",
    arn: opts.arn ?? row.arn ?? null,
    nil: Boolean(num(row.is_nil)),
  })
  const cols = Object.keys(values)
  await query(
    `UPDATE gst_return_filings SET ${cols.map((c) => `${c}=?`).join(",")},
       revision = ?, filed_at = NOW(), filed_by = ?, filed_by_name = ?
      WHERE id = ?`,
    [...cols.map((c) => values[c]), revision, actorId ?? null, actorName ?? null, row.id],
  )

  await logFinanceEvent({
    entityType: "gst_filing",
    entityRef: row.filing_id,
    type: "updated",
    summary: `GSTR-1 for ${period} amended (rev ${revision})${opts.reason ? `: ${opts.reason}` : ""}`,
    amount: summary.totals.total_tax,
    actorId: actorId ?? null,
  }).catch(() => {})
  return { filing_id: row.filing_id, period, revision }
}

/** The amendment audit trail for a period, newest first (Phase 14). */
export async function listReturnAmendments(period: string) {
  await ensureGstFilingSchema()
  return (await query(
    `SELECT id, filing_id, revision, previous_status, previous_arn, previous_total_taxable,
            previous_total_tax, reason, amended_by, amended_at
       FROM gst_return_amendments WHERE period = ? ORDER BY revision DESC, id DESC`,
    [period],
  ).catch(() => [])) as any[]
}

type Gstr1Invoice = {
  invoice_id: string
  invoice_date: any
  invoice_type: string
  client_name: string
  client_legal_name: string
  client_gstin: string
  gst_registration: string
  gst_type: string
  gst_rate: number
  place_of_supply: string
  supply_type: any
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  total: number
}

type SectionBucket = {
  key: string
  title: string
  description: string
  count: number
  taxable: number
  tax: number
  rows: Gstr1Invoice[]
}

/**
 * Phase 3 — organize the period's outward documents into the standard GSTR-1
 * data sections, derived ENTIRELY from fields the sales invoice already carries
 * (invoice type, customer GSTIN, tax split). No fabricated fields:
 *
 *   B2B      — registered customer (has GSTIN), taxable supply
 *   B2C      — unregistered customer, taxable supply
 *   Credit   — Credit Notes (reduce output liability)
 *   Debit    — Debit Notes (increase output liability)
 *   Nil/Exempt/Zero-Rated — documents with taxable value but ₹0 GST
 *
 * Export is intentionally NOT a separate bucket: the sales-invoice schema has no
 * export / overseas flag, so zero-tax supplies fold into Nil/Exempt/Zero-Rated
 * rather than inventing an export classification the source data can't support.
 */
function buildGstr1Sections(rows: Gstr1Invoice[]) {
  const mk = (key: string, title: string, description: string): SectionBucket => ({
    key, title, description, count: 0, taxable: 0, tax: 0, rows: [],
  })
  const b2b = mk("b2b", "B2B", "Registered customers (GSTIN on file)")
  const b2c = mk("b2c", "B2C", "Unregistered customers")
  const nil = mk("nil", "Nil / Exempt / Zero-Rated", "Taxable value with ₹0 GST")
  const credit = mk("credit_notes", "Credit Notes", "Reduce output tax liability")
  const debit = mk("debit_notes", "Debit Notes", "Increase output tax liability")

  const push = (b: SectionBucket, r: Gstr1Invoice) => {
    b.rows.push(r)
    b.count += 1
    b.taxable = round2(b.taxable + num(r.taxable))
    b.tax = round2(b.tax + num(r.cgst) + num(r.sgst) + num(r.igst) + num(r.cess))
  }

  for (const r of rows) {
    const type = String(r.invoice_type || "")
    if (type === "Credit Note") { push(credit, r); continue }
    if (type === "Debit Note") { push(debit, r); continue }
    const tax = num(r.cgst) + num(r.sgst) + num(r.igst) + num(r.cess)
    if (num(r.taxable) > 0 && tax <= 0) { push(nil, r); continue }
    if (r.client_gstin) push(b2b, r)
    else push(b2c, r)
  }

  return [b2b, b2c, nil, credit, debit]
}

function financialYearFor(dateStr: string) {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const start = d.getMonth() >= 3 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}

// ── Reconciliation (Phase 17–19) ────────────────────────────────────────────
// The reconciliation surfaces do NOT recompute GST; they cross-check the numbers
// the existing engines already produce (live sales books, filed GSTR-1 snapshot,
// the shared GST Input register, GSTR-2B and recorded tax payments) and classify
// the differences. This keeps a single source of truth per dimension.

const EPS = 1 // ₹1 tolerance to absorb rounding across independent aggregations

type ReconStatus = "Matched" | "Mismatch" | "Missing" | "Extra" | "Pending"

function classifyAmount(a: number, b: number): ReconStatus {
  if (Math.abs(round2(a) - round2(b)) <= EPS) return "Matched"
  return "Mismatch"
}

/**
 * OUTPUT reconciliation (Phase 19) — live Sales-Invoice GST vs the FILED GSTR-1
 * snapshot for the period, invoice by invoice. When the period is not yet filed
 * every live document is reported as "Pending" (nothing to compare against). Once
 * filed, each document is Matched / Mismatch, plus documents present only in the
 * books ("Missing" from the filed return, i.e. added after filing) or only in the
 * snapshot ("Extra", i.e. removed/cancelled after filing).
 */
export async function reconcileOutputGst(period: string) {
  await ensureGstFilingSchema()
  const summary = await gstSummary(period)
  const live: Gstr1Invoice[] = summary.invoices || []

  const [filed] = (await query(
    `SELECT status, snapshot FROM gst_return_filings
       WHERE return_type = 'GSTR-1' AND period = ? LIMIT 1`,
    [period],
  )) as any[]
  const isFiled = filed && isLocked(String(filed.status))

  const taxOf = (r: Gstr1Invoice) => round2(num(r.cgst) + num(r.sgst) + num(r.igst) + num(r.cess))

  if (!isFiled) {
    const rows = live.map((r) => ({
      invoice_id: r.invoice_id,
      client_name: r.client_name,
      books_taxable: round2(num(r.taxable)),
      books_tax: taxOf(r),
      filed_taxable: null as number | null,
      filed_tax: null as number | null,
      status: "Pending" as ReconStatus,
    }))
    return {
      period,
      filed: false,
      status_label: summary.workflow.status,
      counts: { matched: 0, mismatch: 0, missing: 0, extra: 0, pending: rows.length },
      totals: {
        books_taxable: summary.totals.taxable,
        books_tax: summary.totals.total_tax,
        filed_taxable: 0,
        filed_tax: 0,
      },
      rows,
    }
  }

  let snapshot: any = {}
  try {
    snapshot = typeof filed.snapshot === "string" ? JSON.parse(filed.snapshot) : filed.snapshot || {}
  } catch {
    snapshot = {}
  }
  const filedInvoices: Gstr1Invoice[] = snapshot.invoices || []
  const filedMap = new Map(filedInvoices.map((r) => [String(r.invoice_id), r]))
  const liveMap = new Map(live.map((r) => [String(r.invoice_id), r]))

  const rows: any[] = []
  const counts = { matched: 0, mismatch: 0, missing: 0, extra: 0, pending: 0 }

  for (const r of live) {
    const f = filedMap.get(String(r.invoice_id))
    if (!f) {
      counts.missing += 1
      rows.push({
        invoice_id: r.invoice_id, client_name: r.client_name,
        books_taxable: round2(num(r.taxable)), books_tax: taxOf(r),
        filed_taxable: null, filed_tax: null, status: "Missing" as ReconStatus,
      })
      continue
    }
    const status = classifyAmount(num(r.taxable) + taxOf(r), num(f.taxable) + taxOf(f))
    counts[status === "Matched" ? "matched" : "mismatch"] += 1
    rows.push({
      invoice_id: r.invoice_id, invoice_number: r.invoice_number, client_name: r.client_name,
      books_taxable: round2(num(r.taxable)), books_tax: taxOf(r),
      filed_taxable: round2(num(f.taxable)), filed_tax: taxOf(f), status,
    })
  }
  for (const f of filedInvoices) {
    if (liveMap.has(String(f.invoice_id))) continue
    counts.extra += 1
    rows.push({
      invoice_id: f.invoice_id, invoice_number: f.invoice_number, client_name: f.client_name,
      books_taxable: null, books_tax: null,
      filed_taxable: round2(num(f.taxable)), filed_tax: taxOf(f), status: "Extra" as ReconStatus,
    })
  }

  const filedTotals = snapshot.totals || {}
  return {
    period,
    filed: true,
    status_label: String(filed.status),
    counts,
    totals: {
      books_taxable: summary.totals.taxable,
      books_tax: summary.totals.total_tax,
      filed_taxable: round2(num(filedTotals.taxable)),
      filed_tax: round2(num(filedTotals.total_tax)),
    },
    rows,
  }
}

/**
 * Reconciliation CENTER (Phase 17/18) — a period dashboard that lines up every
 * GST dimension against the counterpart it must agree with, and flags drift:
 *
 *   Output tax   : Sales Books  ⇄  filed GSTR-1
 *   Output tax   : Sales Books  ⇄  GSTR-3B (auto)
 *   Input ITC    : GST Input register  ⇄  GSTR-2B
 *   Net liability: (Output − ITC)  ⇄  Tax payment recorded
 */
export async function gstReconciliationCenter(period: string) {
  await ensureGstFilingSchema()
  const summary = await gstSummary(period)

  const salesTax = summary.totals.total_tax
  const salesTaxable = summary.totals.taxable

  // Filed GSTR-1 snapshot (if any).
  const [filed] = (await query(
    `SELECT status, total_tax, total_taxable FROM gst_return_filings
       WHERE return_type = 'GSTR-1' AND period = ? LIMIT 1`,
    [period],
  )) as any[]
  const isFiled = filed && isLocked(String(filed.status))

  // GST Input register — net eligible ITC already computed inside the summary.
  const itcRegister = summary.liability.input_gst

  // GSTR-2B totals for the period (independent inward feed).
  const [g2b] = (await query(
    `SELECT COALESCE(SUM(total_tax),0) AS tax, COUNT(*) AS n FROM finance_gstr2b WHERE period = ?`,
    [period],
  ).catch(() => [{ tax: 0, n: 0 }])) as any[]
  const g2bTax = round2(num(g2b?.tax))

  // Net liability and any recorded tax payment for the period.
  const netLiability = summary.liability.net_liability
  const [pay] = (await query(
    `SELECT COALESCE(SUM(amount),0) AS paid, COUNT(*) AS n FROM gst_tax_payments WHERE period = ?`,
    [period],
  ).catch(() => [{ paid: 0, n: 0 }])) as any[]
  const paid = round2(num(pay?.paid))
  const hasPayment = Number(pay?.n ?? 0) > 0

  const lines = [
    {
      key: "output_gstr1",
      label: "Output tax — Sales Books vs GSTR-1",
      left_label: "Sales Books",
      left: salesTax,
      right_label: isFiled ? "Filed GSTR-1" : "GSTR-1 (not filed)",
      right: isFiled ? round2(num(filed.total_tax)) : 0,
      status: isFiled ? classifyAmount(salesTax, num(filed.total_tax)) : ("Pending" as ReconStatus),
    },
    {
      key: "output_gstr3b",
      label: "Output tax — Sales Books vs GSTR-3B",
      left_label: "Sales Books",
      left: salesTax,
      right_label: "GSTR-3B (auto)",
      right: salesTax,
      status: "Matched" as ReconStatus,
    },
    {
      key: "itc_2b",
      label: "Input ITC — Register vs GSTR-2B",
      left_label: "GST Input register",
      left: itcRegister,
      right_label: "GSTR-2B",
      right: g2bTax,
      status: Number(g2b?.n ?? 0) === 0 && itcRegister === 0 ? ("Matched" as ReconStatus) : classifyAmount(itcRegister, g2bTax),
    },
    {
      key: "net_payment",
      label: "Net liability — Payable vs Paid",
      left_label: "Net payable",
      left: netLiability,
      right_label: hasPayment ? "Tax paid" : "No payment recorded",
      right: paid,
      status:
        netLiability <= 0
          ? ("Matched" as ReconStatus)
          : hasPayment
            ? classifyAmount(netLiability, paid)
            : ("Pending" as ReconStatus),
    },
  ]

  return {
    period,
    financial_year: summary.financial_year,
    filed: Boolean(isFiled),
    headline: {
      sales_taxable: salesTaxable,
      sales_tax: salesTax,
      itc: itcRegister,
      net_liability: netLiability,
      paid,
      gstr2b_tax: g2bTax,
    },
    lines,
  }
}
