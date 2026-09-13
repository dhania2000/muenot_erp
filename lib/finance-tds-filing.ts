import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { logFinanceEvent } from "@/lib/finance-audit"

/**
 * TDS filing engine (server-only) — Phase 3.
 *
 * On the sales side, TDS is tax the CUSTOMER deducts from what they owe us; it
 * is captured per invoice as `tds_amount` against a `tds_section`. This engine
 * derives a section-wise TDS summary for a tax period (a calendar month) from
 * the posted-invoice ledger so the numbers reconcile with what was actually
 * billed (spec 64–70, 214).
 *
 * Only Issued / Sent / Posted documents with TDS applicable are included, and a
 * period can be locked once (duplicate prevention). Schema is self-creating +
 * idempotent — `tds_filings` has no migration yet.
 */

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

let ensured = false

export async function ensureTdsFilingSchema() {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS tds_filings (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      filing_id VARCHAR(40) NOT NULL,
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
      UNIQUE KEY uq_tds_period (period),
      UNIQUE KEY uq_tds_filing_id (filing_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
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

const INCLUDED_STATUS = "('Issued','Sent','Posted')"

/** Section-wise TDS summary for a calendar-month period. */
export async function tdsSummary(period: string) {
  await ensureTdsFilingSchema()
  const { from, to } = periodRange(period)

  const sections = (await query(
    `SELECT COALESCE(NULLIF(tds_section,''),'Unspecified') AS section,
            COUNT(*) AS invoice_count,
            COALESCE(SUM(taxable_amount),0) AS base,
            COALESCE(SUM(tds_amount),0) AS tds,
            COALESCE(AVG(NULLIF(tds_rate,0)),0) AS avg_rate
       FROM sales_invoices
      WHERE invoice_date >= ? AND invoice_date <= ?
        AND invoice_status IN ${INCLUDED_STATUS}
        AND invoice_type NOT IN ('Proforma Invoice','Credit Note')
        AND tds_applicable = 1 AND tds_amount > 0
      GROUP BY COALESCE(NULLIF(tds_section,''),'Unspecified')
      ORDER BY tds DESC`,
    [from, to],
  ).catch(() => [])) as any[]

  const totalBase = round2(sections.reduce((s, r) => s + num(r.base), 0))
  const totalTds = round2(sections.reduce((s, r) => s + num(r.tds), 0))
  const invoiceCount = sections.reduce((s, r) => s + Number(r.invoice_count || 0), 0)

  const [existing] = (await query(`SELECT * FROM tds_filings WHERE period = ? LIMIT 1`, [period])) as any[]

  return {
    period,
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

export async function listTdsFilings() {
  await ensureTdsFilingSchema()
  return (await query(`SELECT * FROM tds_filings ORDER BY period DESC, id DESC LIMIT 200`)) as any[]
}

export async function fileTdsReturn(period: string, challanNo: string | null, actorId?: number | null) {
  await ensureTdsFilingSchema()
  const [existing] = (await query(`SELECT id FROM tds_filings WHERE period = ? LIMIT 1`, [period])) as any[]
  if (existing) throw new Error(`TDS for ${period} is already filed. Use an amendment instead.`)

  const summary = await tdsSummary(period)
  if (summary.totals.invoice_count === 0) throw new Error(`No TDS entries found for ${period}; nothing to file.`)

  const filingId = await nextRecordId("TDS")
  const fy = financialYearFor(`${period}-01`)
  await query(
    `INSERT INTO tds_filings
       (filing_id, period, financial_year, invoice_count, total_base, total_tds, status, challan_no, snapshot, filed_at, filed_by)
     VALUES (?,?,?,?,?,?,?,?,?,NOW(),?)`,
    [
      filingId, period, fy, summary.totals.invoice_count, summary.totals.total_base,
      summary.totals.total_tds, "Filed", challanNo || null, JSON.stringify(summary), actorId ?? null,
    ],
  )
  await logFinanceEvent({
    entityType: "tds_filing",
    entityRef: filingId,
    type: "posted",
    summary: `TDS filed for ${period}: base ${summary.totals.total_base}, TDS ${summary.totals.total_tds}`,
    amount: summary.totals.total_tds,
    actorId: actorId ?? null,
  })
  return { filing_id: filingId, period }
}

function financialYearFor(dateStr: string) {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const start = d.getMonth() >= 3 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}
