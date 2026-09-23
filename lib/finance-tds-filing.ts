import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { logFinanceEvent } from "@/lib/finance-audit"
import { normalizePan, panStatus, requiresNoPanRate } from "@/lib/pan"

/**
 * TDS filing engine (server-only) — Phase 3 (receivable) + purchase extension
 * (payable).
 *
 * TDS has two directions and they must never be mixed in one return:
 *  - "receivable": tax the CUSTOMER deducts from what they owe us, captured per
 *    sales invoice as `tds_amount` against a `tds_section`. This is a credit we
 * reconcile against Form 26AS (–70, 214).
 *  - "payable": tax WE deduct from vendor bills and must deposit with the
 *    government, captured per purchase bill. This is the deductor-side 26Q
 *    return.
 *
 * Each direction derives a section-wise summary for a calendar-month period
 * from its source ledger so the numbers reconcile with what was actually
 * billed. A period can be locked once per direction (duplicate prevention).
 * Schema is self-creating + idempotent.
 */

export type TdsDirection = "receivable" | "payable" | "employee"

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

const normDirection = (d: any): TdsDirection => {
  const s = String(d)
  if (s === "payable") return "payable"
  if (s === "employee") return "employee"
  return "receivable"
}

let ensured = false

/** Add a column to a source table if it is missing (idempotent, self-healing). */
async function ensureColumn(table: string, column: string, ddl: string) {
  const rows = (await query<any[]>(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  ).catch(() => [])) as any[]
  if (rows.length === 0) {
    await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).catch(() => {})
  }
}

export async function ensureTdsFilingSchema() {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS tds_filings (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      filing_id VARCHAR(40) NOT NULL,
      direction VARCHAR(12) NOT NULL DEFAULT 'receivable',
      period VARCHAR(7) NOT NULL,               -- YYYY-MM
      financial_year VARCHAR(12) DEFAULT NULL,
      invoice_count INT NOT NULL DEFAULT 0,
      total_base DECIMAL(16,2) NOT NULL DEFAULT 0,
      total_tds DECIMAL(16,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'Filed',
      challan_no VARCHAR(40) DEFAULT NULL,
      snapshot LONGTEXT DEFAULT NULL,
      filed_at TIMESTAMP NULL DEFAULT NULL,
      filed_by BIGINT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tds_filing_id (filing_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Self-heal a pre-existing `tds_filings` table. A different, line-item
  // variant of this table ships in the 2026-09-07 dedicated-tables migration
  // (keyed on `tds_filing_id`, with none of the summary columns below). Since
  // both use CREATE TABLE IF NOT EXISTS, whichever ran first wins — so when the
  // migration's table is present, the engine's columns are missing. Add every
  // required column idempotently via ensureColumn WITHOUT an `AFTER <col>`
  // clause: referencing `filing_id` in an ALTER threw "Unknown column
  // 'filing_id'" on the legacy table. Each column is nullable/defaulted so it
  // can be back-filled onto rows that already exist.
  await ensureColumn("tds_filings", "filing_id", "VARCHAR(40) NULL")
  await ensureColumn("tds_filings", "direction", "VARCHAR(12) NOT NULL DEFAULT 'receivable'")
  await ensureColumn("tds_filings", "period", "VARCHAR(7) NULL")
  await ensureColumn("tds_filings", "financial_year", "VARCHAR(12) DEFAULT NULL")
  await ensureColumn("tds_filings", "invoice_count", "INT NOT NULL DEFAULT 0")
  await ensureColumn("tds_filings", "total_base", "DECIMAL(16,2) NOT NULL DEFAULT 0")
  await ensureColumn("tds_filings", "total_tds", "DECIMAL(16,2) NOT NULL DEFAULT 0")
  await ensureColumn("tds_filings", "status", "VARCHAR(20) NOT NULL DEFAULT 'Filed'")
  await ensureColumn("tds_filings", "challan_no", "VARCHAR(40) DEFAULT NULL")
  await ensureColumn("tds_filings", "snapshot", "LONGTEXT DEFAULT NULL")
  await ensureColumn("tds_filings", "filed_at", "TIMESTAMP NULL DEFAULT NULL")
  await ensureColumn("tds_filings", "filed_by", "BIGINT UNSIGNED DEFAULT NULL")

  // The migration's `tds_filing_id` is NOT NULL with no default; summary
  // inserts never set it, so relax it (if present) to avoid insert failures.
  await query(`ALTER TABLE tds_filings MODIFY COLUMN tds_filing_id VARCHAR(40) NULL`).catch(() => {})

  // Drop the old period-only unique key and enforce uniqueness per
  // (period, direction). Guarded so a legacy layout can't abort the ensure.
  const oldIdx = (await query<any[]>(
    `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'tds_filings' AND index_name = 'uq_tds_period' LIMIT 1`,
  ).catch(() => [])) as any[]
  if (oldIdx.length > 0) await query(`ALTER TABLE tds_filings DROP INDEX uq_tds_period`).catch(() => {})

  const newIdx = (await query<any[]>(
    `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'tds_filings' AND index_name = 'uq_tds_period_dir' LIMIT 1`,
  ).catch(() => [])) as any[]
  if (newIdx.length === 0)
    await query(`ALTER TABLE tds_filings ADD UNIQUE KEY uq_tds_period_dir (period, direction)`).catch(() => {})

  // Deductee PAN snapshots frozen on the source document, mirroring the
  // vendor_pan snapshot already carried on purchase bills / expenses. FTE and
  // freelance invoices had no PAN column, so the payee-side return could never
  // report a valid PAN. These are captured at invoice entry (see the FTE /
  // Freelance module configs) and read back into the deductee ledger.
  await ensureColumn("fte_invoices", "employee_pan", "VARCHAR(10) DEFAULT NULL")
  await ensureColumn("freelance_invoices", "freelancer_pan", "VARCHAR(10) DEFAULT NULL")

  ensured = true
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

function periodRange(period: string) {
  if (!PERIOD_RE.test(period)) throw new Error("Period must be in YYYY-MM format.")
  const [y, m] = period.split("-").map(Number)
  const from = `${period}-01`
  const last = new Date(y, m, 0).getDate()
  const to = `${period}-${String(last).padStart(2, "0")}`
  return { from, to }
}

/**
 * Section-wise TDS aggregate for a period, per direction. Receivable reads the
 * sales-invoice ledger (posted docs only); payable reads the purchase-bill
 * ledger. Both return the same shape so a single filing pipeline serves each.
 */
async function sectionAggregate(period: string, direction: TdsDirection) {
  const { from, to } = periodRange(period)

  if (direction === "employee") {
    // Employee-side TDS is deducted on FTE (salaried) invoices and on freelance
    // invoices. FTE deductions are salary TDS (§192) captured in the flat `tds`
    // column with no section, so tag them 192 and derive the effective rate;
    // freelance invoices carry their own statutory section/rate (§194J etc.).
    // Both feed one payee-side return, aggregated by section.
    return (await query(
      `SELECT section,
              COUNT(*) AS invoice_count,
              COALESCE(SUM(base),0) AS base,
              COALESCE(SUM(tds),0) AS tds,
              COALESCE(AVG(NULLIF(rate,0)),0) AS avg_rate
         FROM (
           SELECT '192' AS section,
                  gross_earnings AS base, tds AS tds,
                  CASE WHEN gross_earnings > 0 THEN ROUND(tds / gross_earnings * 100, 2) ELSE 0 END AS rate
             FROM fte_invoices
            WHERE invoice_date >= ? AND invoice_date <= ?
              AND COALESCE(tds,0) > 0
              AND COALESCE(status,'') NOT IN ('Cancelled','Draft','Void')
           UNION ALL
           SELECT COALESCE(NULLIF(tds_section,''),'194J') AS section,
                  gross_amount AS base, tds_amount AS tds, tds_rate AS rate
             FROM freelance_invoices
            WHERE invoice_date >= ? AND invoice_date <= ?
              AND tds_applicable = 1 AND tds_amount > 0
              AND COALESCE(approval_status,'') NOT IN ('Rejected','Cancelled','Void')
         ) u
        GROUP BY section
        ORDER BY tds DESC`,
      [from, to, from, to],
    ).catch(() => [])) as any[]
  }

  if (direction === "payable") {
    // Payable TDS is deducted BOTH on vendor purchase bills and on vendor
    // expenses (Phase 26/40). Both ledgers feed one 26Q return, so aggregate
    // over their union keyed on the statutory section.
    return (await query(
      `SELECT section,
              COUNT(*) AS invoice_count,
              COALESCE(SUM(base),0) AS base,
              COALESCE(SUM(tds),0) AS tds,
              COALESCE(AVG(NULLIF(rate,0)),0) AS avg_rate
         FROM (
           SELECT COALESCE(NULLIF(tds_section,''),'Unspecified') AS section,
                  COALESCE(NULLIF(tds_base,0), taxable_amount) AS base,
                  tds_amount AS tds, tds_rate AS rate
             FROM purchase_bills
            WHERE bill_date >= ? AND bill_date <= ?
              AND tds_applicable = 1 AND tds_amount > 0
              AND COALESCE(payment_status,'') NOT IN ('Cancelled','Draft','Void')
           UNION ALL
           SELECT COALESCE(NULLIF(tds_section,''),'Unspecified') AS section,
                  COALESCE(NULLIF(tds_base,0), taxable_amount) AS base,
                  tds_amount AS tds, tds_rate AS rate
             FROM expenses
            WHERE expense_date >= ? AND expense_date <= ?
              AND tds_applicable = 1 AND tds_amount > 0
              AND vendor_id IS NOT NULL AND vendor_id <> ''
              AND COALESCE(approval_status,'') NOT IN ('Cancelled','Rejected','Void')
         ) u
        GROUP BY section
        ORDER BY tds DESC`,
      [from, to, from, to],
    ).catch(() => [])) as any[]
  }

  return (await query(
    `SELECT COALESCE(NULLIF(tds_section,''),'Unspecified') AS section,
            COUNT(*) AS invoice_count,
            COALESCE(SUM(taxable_amount),0) AS base,
            COALESCE(SUM(tds_amount),0) AS tds,
            COALESCE(AVG(NULLIF(tds_rate,0)),0) AS avg_rate
       FROM sales_invoices
      WHERE invoice_date >= ? AND invoice_date <= ?
        AND invoice_status IN ('Issued','Sent','Posted')
        AND invoice_type NOT IN ('Proforma Invoice','Credit Note')
        AND tds_applicable = 1 AND tds_amount > 0
      GROUP BY COALESCE(NULLIF(tds_section,''),'Unspecified')
      ORDER BY tds DESC`,
    [from, to],
  ).catch(() => [])) as any[]
}

/**
 * Challan coverage for a period + deductor direction (Phase 24/25): how much of
 * each section / payee has actually been deposited with the government.
 *
 * It prefers explicit challan → deductee allocations (the NSDL-style mapping
 * maintained in the Challans stage) when they exist. When a month's challan has
 * not yet been line-allocated it falls back to distributing that month's
 * deposited TDS across sections / payees pro-rata to their deducted TDS, so a
 * "Paid" / "Balance" figure is always meaningful. Reads the compliance tables
 * directly (guarded) to avoid a circular import with the compliance engine.
 */
async function periodCoverage(period: string, dir: TdsDirection) {
  const challans = (await query(
    `SELECT challan_id, challan_no, tds_amount, interest, late_fee
       FROM tds_challans WHERE direction = ? AND period = ?`,
    [dir, period],
  ).catch(() => [])) as any[]
  const depositedTds = round2(challans.reduce((s, c) => s + num(c.tds_amount), 0))
  // Statutory interest (§201(1A)) and late fee (§234E) actually deposited via
  // this period's challans — read from the same challan ledger, never recomputed.
  const depositedInterest = round2(challans.reduce((s, c) => s + num(c.interest), 0))
  const depositedLateFee = round2(challans.reduce((s, c) => s + num(c.late_fee), 0))
  const challanLabel = challans.map((c) => c.challan_no || c.challan_id).filter(Boolean).join(", ")

  const allocRows = (await query(
    `SELECT section, party_id, party_name, challan_id, amount
       FROM tds_challan_allocations WHERE direction = ? AND period = ?`,
    [dir, period],
  ).catch(() => [])) as any[]
  const hasAlloc = allocRows.length > 0

  const bySection = new Map<string, number>()
  const byParty = new Map<string, { amount: number; challans: Set<string> }>()
  for (const a of allocRows) {
    const sec = String(a.section || "")
    bySection.set(sec, round2((bySection.get(sec) || 0) + num(a.amount)))
    const key = `${a.party_id || a.party_name || "—"}::${sec}`
    const e = byParty.get(key) || { amount: 0, challans: new Set<string>() }
    e.amount = round2(e.amount + num(a.amount))
    if (a.challan_id) e.challans.add(String(a.challan_id))
    byParty.set(key, e)
  }
  return { depositedTds, depositedInterest, depositedLateFee, challanLabel, hasAlloc, bySection, byParty }
}

/** Deposit status of a deducted line given how much of it has been paid. */
export function tdsPayStatus(dir: TdsDirection, tds: number, paid: number, docStatus = ""): string {
  if (dir === "receivable") return "Credit"
  if (tds <= 0) return docStatus || "—"
  if (paid >= tds - 0.01) return "Paid"
  if (paid > 0) return "Partial"
  return "Pending"
}

export type TdsSummaryOpts = { coverage?: boolean }

/** Section-wise TDS summary for a calendar-month period and direction. */
export async function tdsSummary(
  period: string,
  direction: TdsDirection = "receivable",
  opts: TdsSummaryOpts = {},
) {
  await ensureTdsFilingSchema()
  const dir = normDirection(direction)
  const { from, to } = periodRange(period)
  const sections = await sectionAggregate(period, dir)

  const totalBase = round2(sections.reduce((s, r) => s + num(r.base), 0))
  const totalTds = round2(sections.reduce((s, r) => s + num(r.tds), 0))
  const invoiceCount = sections.reduce((s, r) => s + Number(r.invoice_count || 0), 0)

  const coverage = opts.coverage && dir !== "receivable" ? await periodCoverage(period, dir) : null

  const sectionsOut = sections.map((r) => {
    const tds = round2(num(r.tds))
    let paid = 0
    if (coverage) {
      paid = coverage.hasAlloc
        ? coverage.bySection.get(r.section) || 0
        : totalTds > 0
          ? round2(coverage.depositedTds * (tds / totalTds))
          : 0
    }
    return {
      section: r.section,
      invoice_count: Number(r.invoice_count || 0),
      base: round2(num(r.base)),
      tds,
      avg_rate: round2(num(r.avg_rate)),
      paid: round2(paid),
      balance: round2(tds - paid),
      status: tdsPayStatus(dir, tds, round2(paid)),
    }
  })

  const totalPaid = round2(sectionsOut.reduce((s, r) => s + r.paid, 0))
  // Accounting summary (Phase 73): statutory interest + late fee deposited for
  // the period come straight from the challan ledger via `periodCoverage`, so
  // Total liability = deducted TDS + interest + late fee ties back to challans.
  const totalInterest = round2(coverage?.depositedInterest ?? 0)
  const totalLateFee = round2(coverage?.depositedLateFee ?? 0)
  const totalLiability = round2(totalTds + totalInterest + totalLateFee)

  const [existing] = (await query(`SELECT * FROM tds_filings WHERE period = ? AND direction = ? LIMIT 1`, [
    period,
    dir,
  ])) as any[]

  return {
    period,
    direction: dir,
    range: { from, to },
    totals: {
      invoice_count: invoiceCount,
      total_base: totalBase,
      total_tds: totalTds,
      total_interest: totalInterest,
      total_late_fee: totalLateFee,
      total_liability: totalLiability,
      total_paid: totalPaid,
      total_balance: round2(totalTds - totalPaid),
    },
    sections: sectionsOut,
    filing: existing
      ? { filing_id: existing.filing_id, status: existing.status, challan_no: existing.challan_no, filed_at: existing.filed_at }
      : null,
  }
}

/**
 * Raw deductee/vendor-wise TDS ledger for a period and direction (Phase 27/72).
 * This is the line-level register behind the section-wise summary — one row per
 * source document — so a preparer can tie every rupee of the return back to the
 * bill (payable) or invoice (receivable) it came from. Payable rows carry the
 * vendor PAN/GSTIN snapshot frozen on the purchase bill (Phase 47).
 */
export async function tdsDetail(
  period: string,
  direction: TdsDirection = "receivable",
  opts: TdsSummaryOpts = {},
) {
  await ensureTdsFilingSchema()
  const dir = normDirection(direction)
  const { from, to } = periodRange(period)
  let out: any[] = []

  if (dir === "employee") {
    // Line-level payee register: one row per FTE invoice and freelance invoice
    // that carries TDS, each tagged with its source module so a preparer can
    // trace every rupee back to the invoice it came from.
    const rows = (await query(
      `SELECT * FROM (
         SELECT 'FTE Invoice' AS source, fte_invoice_id AS doc_id, invoice_date AS doc_date, fte_invoice_id AS doc_ref,
                financial_year,
                employee_id AS party_id, employee_name AS party_name, employee_name AS party_legal_name,
                UPPER(TRIM(COALESCE(employee_pan,''))) AS pan, '' AS gstin,
                '192' AS section, gross_earnings AS base,
                CASE WHEN gross_earnings > 0 THEN ROUND(tds / gross_earnings * 100, 2) ELSE 0 END AS rate,
                tds AS tds, status AS status, invoice_date AS sort_date
           FROM fte_invoices
          WHERE invoice_date >= ? AND invoice_date <= ?
            AND COALESCE(tds,0) > 0
            AND COALESCE(status,'') NOT IN ('Cancelled','Draft','Void')
         UNION ALL
         SELECT 'Freelance Invoice' AS source, freelance_invoice_id AS doc_id, invoice_date AS doc_date,
                COALESCE(NULLIF(invoice_bill_reference,''), freelance_invoice_id) AS doc_ref,
                financial_year,
                freelancer_id AS party_id, freelancer_name AS party_name, freelancer_name AS party_legal_name,
                UPPER(TRIM(COALESCE(freelancer_pan,''))) AS pan, '' AS gstin,
                COALESCE(NULLIF(tds_section,''),'194J') AS section, gross_amount AS base,
                tds_rate AS rate, tds_amount AS tds, payment_status AS status, invoice_date AS sort_date
           FROM freelance_invoices
          WHERE invoice_date >= ? AND invoice_date <= ?
            AND tds_applicable = 1 AND tds_amount > 0
            AND COALESCE(approval_status,'') NOT IN ('Rejected','Cancelled','Void')
       ) u
       ORDER BY tds DESC, sort_date ASC`,
      [from, to, from, to],
    ).catch(() => [])) as any[]
    out = rows.map((r) => {
      const pan = normalizePan(r.pan)
      return {
        source: r.source,
        doc_id: r.doc_id,
        doc_date: r.doc_date,
        doc_ref: r.doc_ref,
        financial_year: r.financial_year,
        party_id: r.party_id,
        party_name: r.party_legal_name || r.party_name || "—",
        pan,
        pan_status: panStatus(pan),
        no_pan: requiresNoPanRate(pan),
        gstin: r.gstin || "",
        section: r.section,
        base: round2(num(r.base)),
        rate: round2(num(r.rate)),
        tds: round2(num(r.tds)),
        status: r.status || "",
      }
    })
  }

  if (dir === "payable") {
    // Line-level payable register: one row per vendor purchase bill AND vendor
    // expense that carries TDS, each tagged with its source module so a preparer
    // can trace every rupee back to the document it came from (Phase 27/29).
    const rows = (await query(
      `SELECT * FROM (
         SELECT 'Purchase Bill' AS source, bill_id AS doc_id, bill_date AS doc_date, bill_number AS doc_ref,
                financial_year,
                vendor_id AS party_id, vendor_name AS party_name, vendor_legal_name AS party_legal_name,
                vendor_pan AS pan, vendor_gstin AS gstin,
                COALESCE(NULLIF(tds_section,''),'Unspecified') AS section,
                COALESCE(NULLIF(tds_base,0), taxable_amount) AS base,
                tds_rate AS rate, tds_amount AS tds, payment_status AS status, bill_date AS sort_date
           FROM purchase_bills
          WHERE bill_date >= ? AND bill_date <= ?
            AND tds_applicable = 1 AND tds_amount > 0
            AND COALESCE(payment_status,'') NOT IN ('Cancelled','Draft','Void')
         UNION ALL
         SELECT 'Expense' AS source, expense_id AS doc_id, expense_date AS doc_date,
                COALESCE(NULLIF(vendor_invoice_number,''), bill_receipt_no) AS doc_ref,
                financial_year,
                vendor_id AS party_id, vendor_name AS party_name, vendor_legal_name AS party_legal_name,
                vendor_pan AS pan, vendor_gstin AS gstin,
                COALESCE(NULLIF(tds_section,''),'Unspecified') AS section,
                COALESCE(NULLIF(tds_base,0), taxable_amount) AS base,
                tds_rate AS rate, tds_amount AS tds, approval_status AS status, expense_date AS sort_date
           FROM expenses
          WHERE expense_date >= ? AND expense_date <= ?
            AND tds_applicable = 1 AND tds_amount > 0
            AND vendor_id IS NOT NULL AND vendor_id <> ''
            AND COALESCE(approval_status,'') NOT IN ('Cancelled','Rejected','Void')
       ) u
       ORDER BY tds DESC, sort_date ASC`,
      [from, to, from, to],
    ).catch(() => [])) as any[]
    out = rows.map((r) => {
      const pan = normalizePan(r.pan)
      return {
        source: r.source,
        doc_id: r.doc_id,
        doc_date: r.doc_date,
        doc_ref: r.doc_ref,
        financial_year: r.financial_year,
        party_id: r.party_id,
        party_name: r.party_legal_name || r.party_name || "—",
        pan,
        pan_status: panStatus(pan),
        no_pan: requiresNoPanRate(pan),
        gstin: r.gstin || "",
        section: r.section,
        base: round2(num(r.base)),
        rate: round2(num(r.rate)),
        tds: round2(num(r.tds)),
        status: r.status || "",
      }
    })
  }

  const rows = (await query(
    `SELECT invoice_id AS doc_id, invoice_date AS doc_date, invoice_id AS doc_ref,
            financial_year,
            client_id AS party_id, client_name AS party_name,
            COALESCE(NULLIF(tds_section,''),'Unspecified') AS section,
            taxable_amount AS base, tds_rate AS rate, tds_amount AS tds, invoice_status AS status
       FROM sales_invoices
      WHERE invoice_date >= ? AND invoice_date <= ?
        AND invoice_status IN ('Issued','Sent','Posted')
        AND invoice_type NOT IN ('Proforma Invoice','Credit Note')
        AND tds_applicable = 1 AND tds_amount > 0
      ORDER BY tds_amount DESC, invoice_date ASC`,
    [from, to],
  ).catch(() => [])) as any[]
  out = rows.map((r) => ({
    source: "Sales Invoice",
    doc_id: r.doc_id,
    doc_date: r.doc_date,
    doc_ref: r.doc_ref,
    financial_year: r.financial_year,
    party_id: r.party_id,
    party_name: r.party_name || "—",
    pan: "",
    pan_status: "Missing" as const,
    no_pan: false,
    gstin: "",
    section: r.section,
    base: round2(num(r.base)),
    rate: round2(num(r.rate)),
    tds: round2(num(r.tds)),
    status: r.status || "",
  }))

  return enrichDetailCoverage(out, period, dir, opts)
}

/**
 * Adds per-document Paid / Balance / Challan / deposit-Status (Phase 24) to
 * payee-wise detail rows. Paid is derived from challan → deductee allocations
 * for the period when present, otherwise distributed pro-rata to each line's
 * deducted TDS. Receivable lines carry no deposit obligation, so they report a
 * "Credit" status with zero balance owed.
 */
async function enrichDetailCoverage(
  out: any[],
  period: string,
  dir: TdsDirection,
  opts: TdsSummaryOpts,
) {
  if (!opts.coverage || dir === "receivable") {
    return out.map((r) => ({
      ...r,
      paid: 0,
      balance: dir === "receivable" ? 0 : round2(num(r.tds)),
      challan: "",
      pay_status: tdsPayStatus(dir, round2(num(r.tds)), 0, r.status),
    }))
  }

  const coverage = await periodCoverage(period, dir)
  const totalTds = round2(out.reduce((s, r) => s + num(r.tds), 0))
  const groupTds = new Map<string, number>()
  for (const r of out) {
    const key = `${r.party_id || r.party_name || "—"}::${r.section}`
    groupTds.set(key, round2((groupTds.get(key) || 0) + num(r.tds)))
  }

  return out.map((r) => {
    const tds = round2(num(r.tds))
    const key = `${r.party_id || r.party_name || "—"}::${r.section}`
    let paid = 0
    let challan = ""
    if (coverage.hasAlloc) {
      const e = coverage.byParty.get(key)
      const gTds = groupTds.get(key) || 0
      paid = e && gTds > 0 ? round2(e.amount * (tds / gTds)) : 0
      challan = e && e.challans.size ? Array.from(e.challans).join(", ") : ""
    } else {
      paid = totalTds > 0 ? round2(coverage.depositedTds * (tds / totalTds)) : 0
      challan = paid > 0 ? coverage.challanLabel : ""
    }
    return { ...r, paid, balance: round2(tds - paid), challan, pay_status: tdsPayStatus(dir, tds, paid, r.status) }
  })
}

export async function listTdsFilings(direction?: TdsDirection) {
  await ensureTdsFilingSchema()
  if (direction) {
    return (await query(`SELECT * FROM tds_filings WHERE direction = ? ORDER BY period DESC, id DESC LIMIT 200`, [
      normDirection(direction),
    ])) as any[]
  }
  return (await query(`SELECT * FROM tds_filings ORDER BY period DESC, id DESC LIMIT 200`)) as any[]
}

export async function fileTdsReturn(
  period: string,
  challanNo: string | null,
  actorId?: number | null,
  direction: TdsDirection = "receivable",
) {
  await ensureTdsFilingSchema()
  const dir = normDirection(direction)
  const [existing] = (await query(`SELECT id FROM tds_filings WHERE period = ? AND direction = ? LIMIT 1`, [
    period,
    dir,
  ])) as any[]
  if (existing) throw new Error(`TDS (${dir}) for ${period} is already filed. Use an amendment instead.`)

  const summary = await tdsSummary(period, dir)
  if (summary.totals.invoice_count === 0) throw new Error(`No TDS entries found for ${period}; nothing to file.`)

  const filingId = await nextRecordId("TDS")
  const fy = financialYearFor(`${period}-01`)
  await query(
    `INSERT INTO tds_filings
       (filing_id, direction, period, financial_year, invoice_count, total_base, total_tds, status, challan_no, snapshot, filed_at, filed_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,NOW(),?)`,
    [
      filingId, dir, period, fy, summary.totals.invoice_count, summary.totals.total_base,
      summary.totals.total_tds, "Filed", challanNo || null, JSON.stringify(summary), actorId ?? null,
    ],
  )
  await logFinanceEvent({
    entityType: "tds_filing",
    entityRef: filingId,
    type: "posted",
    summary: `TDS (${dir}) filed for ${period}: base ${summary.totals.total_base}, TDS ${summary.totals.total_tds}`,
    amount: summary.totals.total_tds,
    actorId: actorId ?? null,
  })
  return { filing_id: filingId, period, direction: dir }
}

function financialYearFor(dateStr: string) {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const start = d.getMonth() >= 3 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}
