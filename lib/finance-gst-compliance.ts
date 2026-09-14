import "server-only"
import { query } from "@/lib/db"
import { gstSummary, getGstTaxPaid, reconcileOutputGst } from "@/lib/finance-gst-filing"
import { listGstInput } from "@/lib/finance-gst-input"
import { isValidGstinFormat, normalizeGstin, panFromGstin } from "@/lib/gstin"

/**
 * GST compliance analytics (server-only) — Phases 21–30.
 *
 * This module adds NO new GST computation and owns NO new authoritative tables.
 * Every figure is DERIVED from the engines that already exist:
 *
 *   - outward supply / GSTR-1 / GSTR-3B  → gstSummary(period)  (sales_invoices)
 *   - inward ITC (Purchase Bills + Expenses) → listGstInput()  (finance_gst_input)
 *   - GST paid (cash ledger)             → getGstTaxPaid(period)
 *   - books ⇄ filed GSTR-1 diff          → reconcileOutputGst(period)
 *
 * So the compliance surfaces (3B reconciliation, exception centre, raw register,
 * monthly / quarterly / client / vendor / rate / supply summaries and the
 * credit/debit note register) can never disagree with the GST Filing and GST
 * Input screens — they read the same numbers. Nothing here mutates state.
 *
 * Credit / Debit notes (Phase 30) are honoured through the SOURCE transaction,
 * never by editing the original: a Credit Note reduces the outward liability and
 * a Debit Note increases it, and each note keeps its linkage to the invoice it
 * adjusts (original_invoice_id / credit_debit_note_ref).
 */

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const EPS = 1 // ₹1 tolerance to absorb rounding across independent aggregations

function assertPeriod(period: string) {
  if (!PERIOD_RE.test(period)) throw new Error("Period must be in YYYY-MM format.")
}

/** FY quarter label (Apr–Jun = Q1) for a calendar month 1..12. */
function quarterLabel(m: number) {
  const q = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 && m <= 12 ? 3 : 4
  return `Q${q}`
}

/** Indian financial year, e.g. 2026-06 → "2026-27". */
function financialYearFor(dateStr: string) {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const start = d.getMonth() >= 3 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}

/** The 12 tax periods (YYYY-MM) of an Indian FY string like "2026-27". */
function periodsOfFy(fy: string): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(fy)
  if (!m) return []
  const start = Number(m[1]) // April of this calendar year
  const out: string[] = []
  for (let i = 0; i < 12; i++) {
    const month = 4 + i // 4..15
    const y = month <= 12 ? start : start + 1
    const mm = ((month - 1) % 12) + 1
    out.push(`${y}-${String(mm).padStart(2, "0")}`)
  }
  return out
}

// The same inclusion rule the GSTR-1 engine uses: a document belongs in the
// return the moment it leaves Draft (exclude Draft + Cancelled + Proforma).
const INCLUDED_STATUS = "NOT IN ('Draft','Cancelled')"
const PERIOD_MATCH = (col: string) => `YEAR(${col}) = ? AND MONTH(${col}) = ?`

// ── Raw outward register (read straight from sales_invoices) ────────────────
// Not a recomputation — the tax split is exactly what the invoice stored. We
// only read extra columns (HSN, TDS, note linkage) the summary does not surface.
type OutwardRaw = {
  invoice_id: string
  invoice_date: string | null
  invoice_type: string
  financial_year: string | null
  client_name: string
  client_legal_name: string
  client_gstin: string
  client_pan: string
  hsn_sac: string
  place_of_supply: string
  supply_type: string
  invoice_status: string
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  total: number
  tds: number
  original_invoice_id: string | null
  note_ref: string | null
}

async function outwardRawRows(y: number, m: number): Promise<OutwardRaw[]> {
  const rows = (await query(
    `SELECT si.invoice_id, si.invoice_date, si.invoice_type, si.financial_year,
            si.client_name, si.hsn_sac, si.place_of_supply,
            COALESCE(si.supply_type,'Intra-State') AS supply_type,
            si.invoice_status, si.taxable_amount, si.cgst_amount, si.sgst_amount,
            si.igst_amount, si.other_tax_cess AS cess_amount, si.invoice_total,
            si.tds_amount, si.original_invoice_id, si.credit_debit_note_ref,
            COALESCE(c.gst_number,'') AS client_gstin,
            COALESCE(c.pan,'') AS client_pan,
            COALESCE(NULLIF(c.legal_name,''), NULLIF(c.company_name,''), si.client_name) AS client_legal_name
       FROM sales_invoices si
       LEFT JOIN clients c ON c.id = si.client_id OR c.client_code = si.client_id
      WHERE ${PERIOD_MATCH("si.invoice_date")}
        AND si.invoice_status ${INCLUDED_STATUS}
        AND si.invoice_type <> 'Proforma Invoice'
      ORDER BY si.invoice_date ASC, si.invoice_id ASC`,
    [y, m],
  ).catch(() => [])) as any[]

  return rows.map((r) => {
    const gstin = normalizeGstin(r.client_gstin)
    const pan = r.client_pan || (gstin ? panFromGstin(gstin) : null) || ""
    return {
      invoice_id: r.invoice_id,
      invoice_date: r.invoice_date ? String(r.invoice_date).slice(0, 10) : null,
      invoice_type: r.invoice_type || "Tax Invoice",
      financial_year: r.financial_year || financialYearFor(String(r.invoice_date || "")),
      client_name: r.client_name || "—",
      client_legal_name: r.client_legal_name || r.client_name || "—",
      client_gstin: gstin,
      client_pan: pan,
      hsn_sac: r.hsn_sac || "",
      place_of_supply: r.place_of_supply || "",
      supply_type: r.supply_type || "Intra-State",
      invoice_status: r.invoice_status,
      taxable: round2(num(r.taxable_amount)),
      cgst: round2(num(r.cgst_amount)),
      sgst: round2(num(r.sgst_amount)),
      igst: round2(num(r.igst_amount)),
      cess: round2(num(r.cess_amount)),
      total: round2(num(r.invoice_total)),
      tds: round2(num(r.tds_amount)),
      original_invoice_id: r.original_invoice_id || null,
      note_ref: r.credit_debit_note_ref || null,
    }
  })
}

/** The signed multiplier for a document in liability terms (Phase 30). */
function noteSign(type: string): 1 | -1 {
  return String(type) === "Credit Note" ? -1 : 1
}

// ── Phase 24 — monthly summary ──────────────────────────────────────────────
function monthlyFromSummary(
  summary: Awaited<ReturnType<typeof gstSummary>>,
  eligibleItc: number,
) {
  const t = summary.totals
  const l = summary.liability
  return {
    period: summary.period,
    financial_year: summary.financial_year,
    quarter: summary.quarter,
    taxable_outward: round2(t.taxable - t.credit_note_taxable),
    output_gst: l.output_gst,
    input_gst: l.input_gst,
    eligible_itc: round2(eligibleItc),
    itc_reversal: l.itc_reversal,
    rcm: l.rcm_liability,
    net_liability: l.net_liability,
    tax_paid: l.tax_paid,
    balance: l.balance_payable,
  }
}

// ── Phase 28 — rate-wise (retain + Total GST) ───────────────────────────────
function rateWise(summary: Awaited<ReturnType<typeof gstSummary>>) {
  return summary.rate_wise.map((r) => ({
    rate: r.rate,
    taxable: r.taxable,
    cgst: r.cgst,
    sgst: r.sgst,
    igst: r.igst,
    cess: r.cess,
    total_gst: round2(r.cgst + r.sgst + r.igst + r.cess),
  }))
}

// ── Phase 29 — supply-wise (Intra / Inter / Zero-Rated + RCM) ───────────────
function supplyWise(rows: OutwardRaw[], rcmLiability: number) {
  const mk = (key: string, label: string) => ({
    key,
    label,
    count: 0,
    taxable: 0,
    cgst: 0,
    sgst: 0,
    igst: 0,
    cess: 0,
    total_gst: 0,
  })
  const intra = mk("intra", "Intra-State")
  const inter = mk("inter", "Inter-State")
  const zero = mk("zero", "Exempt / Nil / Zero-Rated")

  for (const r of rows) {
    if (String(r.invoice_type) === "Credit Note") continue // reduces, shown separately
    const tax = r.cgst + r.sgst + r.igst + r.cess
    let b = zero
    if (r.taxable > 0 && tax <= 0) b = zero
    else if (String(r.supply_type).toLowerCase().includes("inter")) b = inter
    else b = intra
    b.count += 1
    b.taxable = round2(b.taxable + r.taxable)
    b.cgst = round2(b.cgst + r.cgst)
    b.sgst = round2(b.sgst + r.sgst)
    b.igst = round2(b.igst + r.igst)
    b.cess = round2(b.cess + r.cess)
    b.total_gst = round2(b.total_gst + tax)
  }

  const rcm = { ...mk("rcm", "RCM (inward, reverse charge)"), total_gst: round2(rcmLiability) }
  return [intra, inter, zero, rcm]
}

// ── Phase 26 — client-wise output ───────────────────────────────────────────
function clientWise(rows: OutwardRaw[]) {
  const map = new Map<string, any>()
  for (const r of rows) {
    const key = `${r.client_gstin || "UNREG"}|${r.client_name}`
    const sign = noteSign(r.invoice_type)
    let g = map.get(key)
    if (!g) {
      g = {
        client: r.client_name,
        client_legal_name: r.client_legal_name,
        gstin: r.client_gstin,
        invoices: 0,
        taxable: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        cess: 0,
        total_gst: 0,
      }
      map.set(key, g)
    }
    g.invoices += 1
    g.taxable = round2(g.taxable + sign * r.taxable)
    g.cgst = round2(g.cgst + sign * r.cgst)
    g.sgst = round2(g.sgst + sign * r.sgst)
    g.igst = round2(g.igst + sign * r.igst)
    g.cess = round2(g.cess + sign * r.cess)
    g.total_gst = round2(g.total_gst + sign * (r.cgst + r.sgst + r.igst + r.cess))
  }
  return Array.from(map.values()).sort((a, b) => b.taxable - a.taxable)
}

// ── Phase 27 — vendor-wise input (from the shared ITC register) ─────────────
function vendorWise(inputRows: any[]) {
  const map = new Map<string, any>()
  for (const r of inputRows) {
    const gstin = normalizeGstin(r.vendor_gstin)
    const name = r.vendor_name || r.employee_name || "—"
    const key = `${gstin || "UNREG"}|${name}`
    let g = map.get(key)
    if (!g) {
      g = {
        vendor: name,
        gstin,
        bills: 0,
        taxable: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        cess: 0,
        itc: 0,
        reversal: 0,
        net_itc: 0,
      }
      map.set(key, g)
    }
    g.bills += 1
    g.taxable = round2(g.taxable + num(r.taxable_amount))
    g.cgst = round2(g.cgst + num(r.cgst_amount))
    g.sgst = round2(g.sgst + num(r.sgst_amount))
    g.igst = round2(g.igst + num(r.igst_amount))
    g.cess = round2(g.cess + num(r.cess_amount))
    g.itc = round2(g.itc + num(r.itc_eligible_amount))
    g.reversal = round2(g.reversal + num(r.itc_reversal_amount))
    g.net_itc = round2(g.net_itc + num(r.itc_net))
  }
  return Array.from(map.values()).sort((a, b) => b.net_itc - a.net_itc)
}

// ── Phase 23 — raw transaction register (outward ⊕ inward) ──────────────────
type RawRow = {
  fy: string | null
  month: string
  quarter: string
  source: string
  document_id: string
  number: string
  date: string | null
  party: string
  gstin: string
  pan: string
  supply_type: string
  place_of_supply: string
  hsn_sac: string
  taxable: number
  gst_rate: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  total_gst: number
  itc: number
  tds: number
  status: string
  reconciliation: string
}

function rawRegister(
  period: string,
  m: number,
  outward: OutwardRaw[],
  inputRows: any[],
  returnStatus: string,
): RawRow[] {
  const q = quarterLabel(m)
  const out: RawRow[] = outward.map((r) => {
    const taxTotal = round2(r.cgst + r.sgst + r.igst + r.cess)
    const rate = r.taxable > 0 ? Math.round(((r.cgst + r.sgst + r.igst) / r.taxable) * 100) : 0
    return {
      fy: r.financial_year,
      month: period,
      quarter: q,
      source: r.invoice_type === "Credit Note" ? "Credit Note" : r.invoice_type === "Debit Note" ? "Debit Note" : "Sales Invoice",
      document_id: r.invoice_id,
      number: r.note_ref || r.invoice_id,
      date: r.invoice_date,
      party: r.client_name,
      gstin: r.client_gstin,
      pan: r.client_pan,
      supply_type: r.supply_type,
      place_of_supply: r.place_of_supply,
      hsn_sac: r.hsn_sac,
      taxable: r.taxable,
      gst_rate: rate,
      cgst: r.cgst,
      sgst: r.sgst,
      igst: r.igst,
      cess: r.cess,
      total_gst: taxTotal,
      itc: 0,
      tds: r.tds,
      status: r.invoice_status,
      reconciliation: returnStatus,
    }
  })

  const inward: RawRow[] = inputRows.map((r) => ({
    fy: r.financial_year || null,
    month: r.period || period,
    quarter: q,
    source: r.source || "Purchase Bill",
    document_id: r.source_bill_ref || r.gst_input_id,
    number: r.bill_number || r.source_bill_ref || "—",
    date: r.bill_date ? String(r.bill_date).slice(0, 10) : null,
    party: r.vendor_name || r.employee_name || "—",
    gstin: normalizeGstin(r.vendor_gstin),
    pan: r.vendor_pan || (r.vendor_gstin ? panFromGstin(r.vendor_gstin) || "" : ""),
    supply_type: r.supply_type || "Intra-State",
    place_of_supply: r.place_of_supply || "",
    hsn_sac: r.hsn_sac || "",
    taxable: round2(num(r.taxable_amount)),
    gst_rate: round2(num(r.gst_rate)),
    cgst: round2(num(r.cgst_amount)),
    sgst: round2(num(r.sgst_amount)),
    igst: round2(num(r.igst_amount)),
    cess: round2(num(r.cess_amount)),
    total_gst: round2(num(r.total_gst)),
    itc: round2(num(r.itc_net)),
    tds: 0,
    status: r.status || "—",
    reconciliation: r.reconciliation_status || "Unreconciled",
  }))

  return [...out, ...inward]
}

// ── Phase 30 — credit / debit notes with source linkage ─────────────────────
function creditDebitNotes(rows: OutwardRaw[]) {
  const notes = rows.filter((r) => r.invoice_type === "Credit Note" || r.invoice_type === "Debit Note")
  return notes.map((r) => {
    const tax = round2(r.cgst + r.sgst + r.igst + r.cess)
    const sign = noteSign(r.invoice_type)
    return {
      note_id: r.invoice_id,
      type: r.invoice_type,
      date: r.invoice_date,
      client: r.client_name,
      gstin: r.client_gstin,
      original_invoice: r.original_invoice_id || r.note_ref || null,
      taxable: r.taxable,
      tax,
      total: r.total,
      // Effect on the period's net output liability: CN reduces, DN increases.
      liability_effect: round2(sign * tax),
      status: r.invoice_status,
    }
  })
}

// ── Phase 21 — GSTR-3B reconciliation (GSTR-1 + 2B/ITC + RCM  vs  3B) ────────
function classify(a: number, b: number) {
  return Math.abs(round2(a) - round2(b)) <= EPS ? "Matched" : "Mismatch"
}

async function threeBReconciliation(
  period: string,
  summary: Awaited<ReturnType<typeof gstSummary>>,
) {
  // GSTR-2B independent inward feed (staging) for the period.
  const [g2b] = (await query(
    `SELECT COALESCE(SUM(total_tax),0) AS tax, COUNT(*) AS n FROM finance_gstr2b WHERE period = ?`,
    [period],
  ).catch(() => [{ tax: 0, n: 0 }])) as any[]
  const g2bTax = round2(num(g2b?.tax))
  const g2bCount = Number(g2b?.n ?? 0)

  const b = summary.gstr3b
  const outputGstr1 = summary.liability.output_gst
  const output3b = b.outward.net_output_tax
  const itcRegister = summary.liability.input_gst
  const itc3b = b.itc.net
  const rcmInput = summary.liability.rcm_liability
  const rcm3b = b.rcm_liability
  const netComputed = round2(output3b + rcm3b - itc3b)
  const net3b = b.net_tax_payable

  const lines = [
    {
      key: "output",
      label: "Outward output tax",
      source_label: "GSTR-1 output",
      source: outputGstr1,
      target_label: "GSTR-3B outward",
      target: output3b,
      status: classify(outputGstr1, output3b),
    },
    {
      key: "itc",
      label: "Input tax credit",
      source_label: g2bCount > 0 ? "GSTR-2B" : "ITC register",
      source: g2bCount > 0 ? g2bTax : itcRegister,
      target_label: "GSTR-3B ITC",
      target: itc3b,
      status: g2bCount > 0 ? classify(g2bTax, itc3b) : classify(itcRegister, itc3b),
    },
    {
      key: "rcm",
      label: "RCM liability",
      source_label: "Inward RCM",
      source: rcmInput,
      target_label: "GSTR-3B 3.1(d)",
      target: rcm3b,
      status: classify(rcmInput, rcm3b),
    },
    {
      key: "net",
      label: "Net tax payable",
      source_label: "Output + RCM − ITC",
      source: netComputed,
      target_label: "GSTR-3B net",
      target: net3b,
      status: classify(netComputed, net3b),
    },
  ]

  return {
    period,
    gstr2b_present: g2bCount > 0,
    headline: {
      gstr1_output: outputGstr1,
      gstr2b_itc: g2bTax,
      itc_register: itcRegister,
      rcm: rcmInput,
      net_payable: net3b,
    },
    lines,
  }
}

// ── Phase 22 — tax exception centre ─────────────────────────────────────────
type Exception = {
  key: string
  label: string
  description: string
  severity: "error" | "warning" | "info"
  count: number
  items: { ref: string; detail: string }[]
}

async function exceptionCentre(
  period: string,
  summary: Awaited<ReturnType<typeof gstSummary>>,
  outward: OutwardRaw[],
  inputRows: any[],
): Promise<Exception[]> {
  const mk = (
    key: string,
    label: string,
    description: string,
    severity: Exception["severity"],
  ): Exception => ({ key, label, description, severity, count: 0, items: [] })

  const calcErr = mk("gst_calculation_error", "GST Calculation Error", "Tax split inconsistent with the supply type", "error")
  const gstinMissing = mk("gstin_missing", "GSTIN Missing", "Input tax recorded against a vendor with no GSTIN", "warning")
  const gstinMismatch = mk("gstin_mismatch", "GSTIN Mismatch", "A stored GSTIN fails the 15-character format check", "error")
  const invoiceMismatch = mk("invoice_mismatch", "Invoice Mismatch", "Live sales books differ from the filed GSTR-1 snapshot", "warning")
  const taxMismatch = mk("tax_amount_mismatch", "Tax Amount Mismatch", "Purchase tax differs from GSTR-2B beyond tolerance", "warning")
  const itcMismatch = mk("itc_mismatch", "ITC Mismatch", "ITC register total differs from GSTR-2B", "warning")
  const twoBMissing = mk("2b_missing", "2B Missing", "Purchase not found in the auto-drafted GSTR-2B", "warning")
  const rcmMissing = mk("rcm_missing", "RCM Missing", "Unregistered-vendor purchase not marked reverse-charge", "warning")
  const reversalMissing = mk("itc_reversal_missing", "ITC Reversal Missing", "Claimed credit later found ineligible without a reversal", "warning")
  const dupInvoice = mk("duplicate_invoice", "Duplicate Invoice", "Same client, taxable value and total appear more than once", "warning")
  const dupItc = mk("duplicate_itc", "Duplicate ITC", "Same vendor GSTIN and bill number claimed more than once", "error")
  const unpaid = mk("unpaid_gst", "Unpaid GST", "A net GST liability remains after recorded payments", "error")
  const filingPending = mk("filing_pending", "Filing Pending", "The period has documents but the return is not filed", "info")

  // GST Calculation Error + GSTIN mismatch scan across outward + inward.
  const scanSplit = (
    ref: string,
    supply: string,
    cgst: number,
    sgst: number,
    igst: number,
    taxable: number,
  ) => {
    const inter = String(supply).toLowerCase().includes("inter")
    if (taxable <= 0) return
    if (inter && (cgst > 0 || sgst > 0)) calcErr.items.push({ ref, detail: "Inter-State supply carrying CGST/SGST" })
    else if (!inter && igst > 0) calcErr.items.push({ ref, detail: "Intra-State supply carrying IGST" })
    else if (!inter && Math.abs(cgst - sgst) > EPS) calcErr.items.push({ ref, detail: "CGST ≠ SGST on an intra-State supply" })
  }

  for (const r of outward) {
    scanSplit(r.invoice_id, r.supply_type, r.cgst, r.sgst, r.igst, r.taxable)
    if (r.client_gstin && !isValidGstinFormat(r.client_gstin))
      gstinMismatch.items.push({ ref: r.invoice_id, detail: `Client GSTIN ${r.client_gstin}` })
  }
  for (const r of inputRows) {
    const gstin = normalizeGstin(r.vendor_gstin)
    scanSplit(
      r.source_bill_ref || r.gst_input_id,
      r.supply_type || "Intra-State",
      num(r.cgst_amount),
      num(r.sgst_amount),
      num(r.igst_amount),
      num(r.taxable_amount),
    )
    if (gstin && !isValidGstinFormat(gstin))
      gstinMismatch.items.push({ ref: r.source_bill_ref || r.gst_input_id, detail: `Vendor GSTIN ${gstin}` })
    if (!gstin && num(r.total_gst) > 0 && String(r.source) === "Purchase Bill")
      gstinMissing.items.push({ ref: r.source_bill_ref || r.gst_input_id, detail: r.vendor_name || "Unknown vendor" })
    if (!gstin && num(r.taxable_amount) > 0 && !num(r.rcm_applicable))
      rcmMissing.items.push({ ref: r.source_bill_ref || r.gst_input_id, detail: r.vendor_name || "Unregistered vendor" })

    const recon = String(r.reconciliation_status || "")
    if (recon === "Mismatch")
      taxMismatch.items.push({ ref: r.source_bill_ref || r.gst_input_id, detail: `Variance vs 2B ${round2(num(r.match_variance))}` })
    if (recon === "Not in 2B" && num(r.total_gst) > 0)
      twoBMissing.items.push({ ref: r.source_bill_ref || r.gst_input_id, detail: r.vendor_name || "—" })
    if (String(r.status) === "Ineligible" && num(r.itc_claimed) && num(r.itc_reversal_amount) <= 0)
      reversalMissing.items.push({ ref: r.source_bill_ref || r.gst_input_id, detail: "Claimed but ineligible" })
  }

  // Invoice Mismatch — books vs filed GSTR-1 (only meaningful once filed).
  const recon = await reconcileOutputGst(period).catch(() => null)
  if (recon?.filed) {
    for (const row of recon.rows) {
      if (row.status === "Mismatch" || row.status === "Missing" || row.status === "Extra")
        invoiceMismatch.items.push({ ref: row.invoice_id, detail: `${row.status} vs filed return` })
    }
  }

  // ITC Mismatch — one register-level line if 2B is present and diverges.
  const [g2b] = (await query(
    `SELECT COALESCE(SUM(total_tax),0) AS tax, COUNT(*) AS n FROM finance_gstr2b WHERE period = ?`,
    [period],
  ).catch(() => [{ tax: 0, n: 0 }])) as any[]
  if (Number(g2b?.n ?? 0) > 0 && Math.abs(round2(num(g2b.tax)) - summary.liability.input_gst) > EPS)
    itcMismatch.items.push({
      ref: period,
      detail: `Register ${summary.liability.input_gst} vs 2B ${round2(num(g2b.tax))}`,
    })

  // Duplicate invoice — same client + taxable + total more than once.
  const invKey = new Map<string, string[]>()
  for (const r of outward) {
    const k = `${r.client_name}|${r.taxable}|${r.total}`
    const arr = invKey.get(k) || []
    arr.push(r.invoice_id)
    invKey.set(k, arr)
  }
  for (const [, ids] of invKey) {
    if (ids.length > 1) dupInvoice.items.push({ ref: ids.join(", "), detail: `${ids.length} matching documents` })
  }

  // Duplicate ITC — same vendor GSTIN + bill number more than once.
  const itcKey = new Map<string, string[]>()
  for (const r of inputRows) {
    const bill = String(r.bill_number || "").trim()
    if (!bill) continue
    const k = `${normalizeGstin(r.vendor_gstin)}|${bill.toUpperCase()}`
    const arr = itcKey.get(k) || []
    arr.push(r.source_bill_ref || r.gst_input_id)
    itcKey.set(k, arr)
  }
  for (const [, ids] of itcKey) {
    if (ids.length > 1) dupItc.items.push({ ref: ids.join(", "), detail: `${ids.length} matching claims` })
  }

  // Unpaid GST + filing pending — period-level flags.
  if (summary.liability.balance_payable > EPS)
    unpaid.items.push({ ref: period, detail: `Balance payable ${summary.liability.balance_payable}` })
  const status = summary.workflow.status
  const filed = status === "Filed" || status === "Completed" || status === "Amended"
  if (!filed && summary.totals.invoice_count > 0)
    filingPending.items.push({ ref: period, detail: `Status: ${status}` })

  const all = [
    calcErr, gstinMissing, gstinMismatch, invoiceMismatch, taxMismatch, itcMismatch,
    twoBMissing, rcmMissing, reversalMissing, dupInvoice, dupItc, unpaid, filingPending,
  ]
  for (const e of all) e.count = e.items.length
  return all
}

/**
 * The full compliance report for a tax period (Phases 21–24, 26–30). Reuses the
 * GSTR-1/3B engine and the shared ITC register so every figure agrees with the
 * GST Filing and GST Input screens.
 */
export async function gstComplianceReport(period: string) {
  assertPeriod(period)
  const [y, m] = period.split("-").map(Number)

  const summary = await gstSummary(period)
  const inputRows = await listGstInput({ period }).catch(() => [])
  const outward = await outwardRawRows(y, m)
  const eligibleItc = round2(inputRows.reduce((s: number, r: any) => s + num(r.itc_eligible_amount), 0))
  const three_b = await threeBReconciliation(period, summary)
  const exceptions = await exceptionCentre(period, summary, outward, inputRows)

  return {
    period,
    financial_year: summary.financial_year,
    quarter: summary.quarter,
    monthly: monthlyFromSummary(summary, eligibleItc),
    three_b,
    exceptions,
    exception_total: exceptions.reduce((s, e) => s + e.count, 0),
    raw: rawRegister(period, m, outward, inputRows, summary.workflow.status),
    rate_wise: rateWise(summary),
    supply_wise: supplyWise(outward, summary.liability.rcm_liability),
    client_wise: clientWise(outward),
    vendor_wise: vendorWise(inputRows),
    credit_debit_notes: creditDebitNotes(outward),
  }
}

// ── Phase 25 — quarterly summary for a financial year ───────────────────────
export async function gstQuarterlyCompliance(financialYear: string) {
  const fy = String(financialYear || "").trim()
  const periods = periodsOfFy(fy)

  // Outward output tax per period (net of credit notes; debit notes add).
  const outwardByPeriod = (await query(
    `SELECT DATE_FORMAT(invoice_date,'%Y-%m') AS period,
            COALESCE(SUM(CASE WHEN invoice_type='Credit Note' THEN -taxable_amount ELSE taxable_amount END),0) AS taxable,
            COALESCE(SUM(CASE WHEN invoice_type='Credit Note'
                              THEN -(cgst_amount+sgst_amount+igst_amount+other_tax_cess)
                              ELSE (cgst_amount+sgst_amount+igst_amount+other_tax_cess) END),0) AS output_tax
       FROM sales_invoices
      WHERE financial_year = ?
        AND invoice_status ${INCLUDED_STATUS}
        AND invoice_type <> 'Proforma Invoice'
      GROUP BY period`,
    [fy],
  ).catch(() => [])) as any[]

  // Inward ITC per period from the shared register.
  const inwardByPeriod = (await query(
    `SELECT period,
            COALESCE(SUM(itc_net),0) AS itc_net,
            COALESCE(SUM(itc_eligible_amount),0) AS eligible,
            COALESCE(SUM(itc_reversal_amount),0) AS reversal,
            COALESCE(SUM(CASE WHEN rcm_applicable = 1 THEN total_gst ELSE 0 END),0) AS rcm
       FROM finance_gst_input
      WHERE financial_year = ?
      GROUP BY period`,
    [fy],
  ).catch(() => [])) as any[]

  // GST paid per period (cash-ledger challans) limited to this FY's periods.
  const paidByPeriod = periods.length
    ? ((await query(
        `SELECT period, COALESCE(SUM(amount),0) AS paid FROM gst_tax_payments
          WHERE period IN (${periods.map(() => "?").join(",")}) GROUP BY period`,
        periods,
      ).catch(() => [])) as any[])
    : []

  const outMap = new Map(outwardByPeriod.map((r) => [r.period, r]))
  const inMap = new Map(inwardByPeriod.map((r) => [r.period, r]))
  const paidMap = new Map(paidByPeriod.map((r) => [r.period, r]))

  const quarters = {
    Q1: blankQuarter("Q1"),
    Q2: blankQuarter("Q2"),
    Q3: blankQuarter("Q3"),
    Q4: blankQuarter("Q4"),
  }

  for (const p of periods) {
    const m = Number(p.split("-")[1])
    const q = quarterLabel(m) as "Q1" | "Q2" | "Q3" | "Q4"
    const o = outMap.get(p)
    const i = inMap.get(p)
    const pd = paidMap.get(p)
    const output = round2(num(o?.output_tax))
    const itc = round2(num(i?.itc_net))
    const rcm = round2(num(i?.rcm))
    const bucket = quarters[q]
    bucket.output = round2(bucket.output + output)
    bucket.input = round2(bucket.input + round2(num(i?.eligible)))
    bucket.itc = round2(bucket.itc + itc)
    bucket.rcm = round2(bucket.rcm + rcm)
    bucket.liability = round2(bucket.liability + round2(output + rcm - itc))
    bucket.paid = round2(bucket.paid + round2(num(pd?.paid)))
  }

  const rows = [quarters.Q1, quarters.Q2, quarters.Q3, quarters.Q4]
  const total = rows.reduce(
    (acc, r) => ({
      quarter: "FY total",
      output: round2(acc.output + r.output),
      input: round2(acc.input + r.input),
      itc: round2(acc.itc + r.itc),
      rcm: round2(acc.rcm + r.rcm),
      liability: round2(acc.liability + r.liability),
      paid: round2(acc.paid + r.paid),
    }),
    blankQuarter("FY total"),
  )

  return { financial_year: fy, quarters: rows, total }
}

function blankQuarter(quarter: string) {
  return { quarter, output: 0, input: 0, itc: 0, rcm: 0, liability: 0, paid: 0 }
}

/** Distinct financial years present across outward + inward registers. */
export async function gstComplianceFinancialYears(): Promise<string[]> {
  const [sales, input] = await Promise.all([
    query(
      `SELECT DISTINCT financial_year v FROM sales_invoices
        WHERE financial_year IS NOT NULL AND financial_year <> ''`,
    ).catch(() => []) as Promise<any[]>,
    query(
      `SELECT DISTINCT financial_year v FROM finance_gst_input
        WHERE financial_year IS NOT NULL AND financial_year <> ''`,
    ).catch(() => []) as Promise<any[]>,
  ])
  const set = new Set<string>()
  for (const r of [...sales, ...input]) if (r.v) set.add(String(r.v))
  return Array.from(set).sort((a, b) => b.localeCompare(a))
}
