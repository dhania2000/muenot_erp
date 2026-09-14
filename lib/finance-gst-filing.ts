import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { logFinanceEvent } from "@/lib/finance-audit"

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
 * Schema is self-creating + idempotent — `gst_filings` has no migration yet, so
 * the engine owns its DDL the same way the payments/masters modules do.
 */

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

let ensured = false

export async function ensureGstFilingSchema() {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS gst_filings (
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

// A tax document belongs in the GST return the moment it leaves Draft. We
// exclude ONLY Draft (not a real document yet) and Cancelled (voided), so every
// issued invoice for the period flows into GSTR-1 automatically — including
// invoices whose GST works out to ₹0 (exempt / nil-rated / unregistered).
const INCLUDED_STATUS = "NOT IN ('Draft','Cancelled')"

/** Build the GSTR-1 outward-supply summary for a calendar-month period. */
export async function gstSummary(period: string) {
  await ensureGstFilingSchema()
  const { from, to } = periodRange(period)

  const [totals] = (await query(
    `SELECT
        COUNT(*) AS invoice_count,
        COALESCE(SUM(CASE WHEN invoice_type='Credit Note' THEN 0 ELSE taxable_amount END),0) AS taxable,
        COALESCE(SUM(CASE WHEN invoice_type='Credit Note' THEN 0 ELSE cgst_amount END),0) AS cgst,
        COALESCE(SUM(CASE WHEN invoice_type='Credit Note' THEN 0 ELSE sgst_amount END),0) AS sgst,
        COALESCE(SUM(CASE WHEN invoice_type='Credit Note' THEN 0 ELSE igst_amount END),0) AS igst,
        COALESCE(SUM(CASE WHEN invoice_type='Credit Note' THEN 0 ELSE other_tax_cess END),0) AS cess,
        COALESCE(SUM(CASE WHEN invoice_type='Credit Note' THEN taxable_amount ELSE 0 END),0) AS cn_taxable,
        COALESCE(SUM(CASE WHEN invoice_type='Credit Note' THEN (cgst_amount+sgst_amount+igst_amount+other_tax_cess) ELSE 0 END),0) AS cn_tax
      FROM sales_invoices
     WHERE invoice_date >= ? AND invoice_date <= ?
       AND invoice_status ${INCLUDED_STATUS}
       AND invoice_type <> 'Proforma Invoice'`,
    [from, to],
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
      WHERE si.invoice_date >= ? AND si.invoice_date <= ?
        AND si.invoice_status ${INCLUDED_STATUS}
        AND si.invoice_type NOT IN ('Proforma Invoice','Credit Note')
      GROUP BY it.tax_rate
      ORDER BY it.tax_rate ASC`,
    [from, to],
  ).catch(() => [])) as any[]

  const supply = (await query(
    `SELECT COALESCE(supply_type,'Intra-State') AS supply_type,
            COALESCE(SUM(taxable_amount),0) AS taxable,
            COALESCE(SUM(cgst_amount+sgst_amount+igst_amount+other_tax_cess),0) AS tax
       FROM sales_invoices
      WHERE invoice_date >= ? AND invoice_date <= ?
        AND invoice_status ${INCLUDED_STATUS}
        AND invoice_type NOT IN ('Proforma Invoice','Credit Note')
      GROUP BY COALESCE(supply_type,'Intra-State')`,
    [from, to],
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
     WHERE invoice_date >= ? AND invoice_date <= ?`,
    [from, to],
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
       LEFT JOIN clients c ON c.id = si.client_id OR c.client_id = si.client_id
      WHERE si.invoice_date >= ? AND si.invoice_date <= ?
        AND si.invoice_status ${INCLUDED_STATUS}
        AND si.invoice_type <> 'Proforma Invoice'
      ORDER BY si.invoice_date ASC, si.invoice_id ASC`,
    [from, to],
  ).catch(() => [])) as any[]

  const [existing] = (await query(
    `SELECT * FROM gst_filings WHERE return_type = 'GSTR-1' AND period = ? LIMIT 1`,
    [period],
  )) as any[]

  return {
    period,
    range: { from, to },
    totals: {
      invoice_count: Number(totals?.invoice_count ?? 0),
      taxable,
      cgst,
      sgst,
      igst,
      cess,
      total_tax: totalTax,
      credit_note_taxable: round2(num(totals?.cn_taxable)),
      credit_note_tax: round2(num(totals?.cn_tax)),
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
    invoices: invoices.map((r) => {
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
    }),
    excluded: {
      in_period: Number(diag?.in_period ?? 0),
      draft: Number(diag?.draft ?? 0),
      cancelled: Number(diag?.cancelled ?? 0),
      proforma: Number(diag?.proforma ?? 0),
    },
    filing: existing
      ? {
          filing_id: existing.filing_id,
          status: existing.status,
          arn: existing.arn,
          filed_at: existing.filed_at,
        }
      : null,
  }
}

export async function listGstFilings() {
  await ensureGstFilingSchema()
  return (await query(`SELECT * FROM gst_filings ORDER BY period DESC, id DESC LIMIT 200`)) as any[]
}

/** Lock (file) a period's GSTR-1 from the derived summary. Duplicate-safe. */
export async function fileGstReturn(period: string, arn: string | null, actorId?: number | null) {
  await ensureGstFilingSchema()
  const [existing] = (await query(
    `SELECT id FROM gst_filings WHERE return_type = 'GSTR-1' AND period = ? LIMIT 1`,
    [period],
  )) as any[]
  if (existing) throw new Error(`GSTR-1 for ${period} is already filed. Use an amendment instead.`)

  const summary = await gstSummary(period)
  if (summary.totals.invoice_count === 0) {
    throw new Error(`No tax documents found for ${period}; nothing to file.`)
  }

  const filingId = await nextRecordId("GST")
  const fy = financialYearFor(`${period}-01`)
  await query(
    `INSERT INTO gst_filings
       (filing_id, return_type, period, financial_year, invoice_count, total_taxable,
        total_cgst, total_sgst, total_igst, total_cess, total_tax, status, arn, snapshot, filed_at, filed_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?)`,
    [
      filingId, "GSTR-1", period, fy, summary.totals.invoice_count, summary.totals.taxable,
      summary.totals.cgst, summary.totals.sgst, summary.totals.igst, summary.totals.cess,
      summary.totals.total_tax, "Filed", arn || null, JSON.stringify(summary), actorId ?? null,
    ],
  )
  await logFinanceEvent({
    entityType: "gst_filing",
    entityRef: filingId,
    type: "posted",
    summary: `GSTR-1 filed for ${period}: taxable ${summary.totals.taxable}, tax ${summary.totals.total_tax}`,
    amount: summary.totals.total_tax,
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
