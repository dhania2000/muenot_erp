import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { logFinanceEvent } from "@/lib/finance-audit"

/**
 * TDS filing engine (server-only) — Phase 3 (receivable) + purchase extension
 * (payable).
 *
 * TDS has two directions and they must never be mixed in one return:
 *  - "receivable": tax the CUSTOMER deducts from what they owe us, captured per
 *    sales invoice as `tds_amount` against a `tds_section`. This is a credit we
 *    reconcile against Form 26AS (spec 64–70, 214).
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

  // Migrate an existing single-direction table: add `direction`, drop the old
  // period-only unique key, and enforce uniqueness per (period, direction).
  const cols = (await query<any[]>(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'tds_filings' AND column_name = 'direction' LIMIT 1`,
  )) as any[]
  if (cols.length === 0) {
    await query(`ALTER TABLE tds_filings ADD COLUMN direction VARCHAR(12) NOT NULL DEFAULT 'receivable' AFTER filing_id`)
  }

  const oldIdx = (await query<any[]>(
    `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'tds_filings' AND index_name = 'uq_tds_period' LIMIT 1`,
  )) as any[]
  if (oldIdx.length > 0) await query(`ALTER TABLE tds_filings DROP INDEX uq_tds_period`)

  const newIdx = (await query<any[]>(
    `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'tds_filings' AND index_name = 'uq_tds_period_dir' LIMIT 1`,
  )) as any[]
  if (newIdx.length === 0) await query(`ALTER TABLE tds_filings ADD UNIQUE KEY uq_tds_period_dir (period, direction)`)

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

/** Section-wise TDS summary for a calendar-month period and direction. */
export async function tdsSummary(period: string, direction: TdsDirection = "receivable") {
  await ensureTdsFilingSchema()
  const dir = normDirection(direction)
  const { from, to } = periodRange(period)
  const sections = await sectionAggregate(period, dir)

  const totalBase = round2(sections.reduce((s, r) => s + num(r.base), 0))
  const totalTds = round2(sections.reduce((s, r) => s + num(r.tds), 0))
  const invoiceCount = sections.reduce((s, r) => s + Number(r.invoice_count || 0), 0)

  const [existing] = (await query(`SELECT * FROM tds_filings WHERE period = ? AND direction = ? LIMIT 1`, [
    period,
    dir,
  ])) as any[]

  return {
    period,
    direction: dir,
    range: { from, to },
    totals: { invoice_count: invoiceCount, total_base: totalBase, total_tds: totalTds },
    sections: sections.map((r) => ({
      section: r.section,
      invoice_count: Number(r.invoice_count || 0),
      base: round2(num(r.base)),
      tds: round2(num(r.tds)),
      avg_rate: round2(num(r.avg_rate)),
    })),
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
export async function tdsDetail(period: string, direction: TdsDirection = "receivable") {
  await ensureTdsFilingSchema()
  const dir = normDirection(direction)
  const { from, to } = periodRange(period)

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
    return rows.map((r) => ({
      source: r.source,
      doc_id: r.doc_id,
      doc_date: r.doc_date,
      doc_ref: r.doc_ref,
      financial_year: r.financial_year,
      party_id: r.party_id,
      party_name: r.party_legal_name || r.party_name || "—",
      pan: r.pan || "",
      gstin: r.gstin || "",
      section: r.section,
      base: round2(num(r.base)),
      rate: round2(num(r.rate)),
      tds: round2(num(r.tds)),
      status: r.status || "",
    }))
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
    return rows.map((r) => ({
      source: r.source,
      doc_id: r.doc_id,
      doc_date: r.doc_date,
      doc_ref: r.doc_ref,
      financial_year: r.financial_year,
      party_id: r.party_id,
      party_name: r.party_legal_name || r.party_name || "—",
      pan: r.pan || "",
      gstin: r.gstin || "",
      section: r.section,
      base: round2(num(r.base)),
      rate: round2(num(r.rate)),
      tds: round2(num(r.tds)),
      status: r.status || "",
    }))
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
  return rows.map((r) => ({
    source: "Sales Invoice",
    doc_id: r.doc_id,
    doc_date: r.doc_date,
    doc_ref: r.doc_ref,
    financial_year: r.financial_year,
    party_id: r.party_id,
    party_name: r.party_name || "—",
    pan: "",
    gstin: "",
    section: r.section,
    base: round2(num(r.base)),
    rate: round2(num(r.rate)),
    tds: round2(num(r.tds)),
    status: r.status || "",
  }))
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
