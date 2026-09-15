import "server-only"
import { query } from "@/lib/db"
import { tdsDetail, type TdsDirection } from "@/lib/finance-tds-filing"
import {
  ensureTdsComplianceSchema,
  isDeductorDirection,
  monthsOfFy,
  monthsOfQuarter,
  quarterOfPeriod,
  listTdsReturns,
  listCertificates,
  normDirection,
  type TdsQuarter,
} from "@/lib/finance-tds-compliance"
import { tdsReceivableLedger } from "@/lib/finance-tds-receivable"

/**
 * Phase 41–46 — end-to-end TDS traceability & reconciliation.
 *
 * This module DOES NOT deduct or recompute any TDS. It stitches together the
 * figures the existing engine already produces for a single source document and
 * follows it through every statutory layer:
 *
 *   Source (invoice/bill/expense) → TDS Filing → Challan → Bank posting
 *      → Return (24Q/26Q) → Certificate (16/16A)
 *
 * Every layer is read from what already exists:
 *   - Source + deducted TDS + coverage(paid/balance/challan) → `tdsDetail`
 *   - Bank posting (voucher) → `tds_challans.posting_status/voucher_no`
 *   - Return inclusion → `listTdsReturns` (quarter filed)
 *   - Certificate issuance → `listCertificates` (party + quarter)
 *
 * From those layers it derives a single reconciliation status per document from
 * a fixed vocabulary (Phase 42), and carries the source module + source
 * transaction id + deep links so a user can jump straight back to the original
 * record (Phase 43–44). A duplicate-control report (Phase 45) proves each TDS
 * event is unique on (module, txn id, deductee, section).
 */

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100
const TOL = 0.5

export const TDS_RECON_STATUSES = [
  "Matched",
  "Pending",
  "Missing",
  "Paid but Unallocated",
  "Challan Mismatch",
  "Return Mismatch",
  "Certificate Mismatch",
  "Outstanding",
  "Received",
] as const
export type TdsReconStatus = (typeof TDS_RECON_STATUSES)[number]

/** Reverse-traceability route for each source module (Phase 44). */
const SOURCE_ROUTES: Record<string, string> = {
  "Purchase Bill": "/modules/finance/purchase-bills",
  Expense: "/modules/finance/expenses",
  "Sales Invoice": "/modules/finance/sales-invoices",
  "FTE Invoice": "/modules/finance/fte-invoices",
  "Freelance Invoice": "/modules/finance/freelance-invoices",
}
const PARTY_ROUTE = "/modules/finance/customers-vendors"

function sourceHref(module: string, docId: string): string {
  const base = SOURCE_ROUTES[module]
  return base && docId ? `${base}?id=${encodeURIComponent(docId)}` : ""
}
function partyHref(partyId: string): string {
  return partyId ? `${PARTY_ROUTE}?id=${encodeURIComponent(partyId)}` : ""
}

export type TdsTraceRow = {
  // Source layer (Phase 43)
  source_module: string
  source_txn_id: string
  source_ref: string
  source_href: string
  doc_date: string
  quarter: TdsQuarter
  party_id: string
  party_name: string
  party_href: string
  pan: string
  pan_status: string
  section: string
  base: number
  deducted: number
  // Filing layer
  filed: boolean
  filing_id: string | null
  // Challan + Bank layer
  deposited: number
  balance: number
  challan_ref: string
  bank_posted: boolean
  bank_voucher: string | null
  // Return layer
  returned: boolean
  return_id: string | null
  // Certificate layer
  certified: boolean
  certificate_id: string | null
  // Verdict (Phase 42)
  status: TdsReconStatus
  dup_key: string
}

const RECON_STAGE_DONE: Record<string, boolean> = {}

function deductorStatus(args: {
  deducted: number
  deposited: number
  challanInPeriod: boolean
  bankPosted: boolean
  returned: boolean
  certified: boolean
  panMissing: boolean
  sectionMissing: boolean
}): TdsReconStatus {
  const { deducted, deposited, challanInPeriod, bankPosted, returned, certified, panMissing, sectionMissing } = args
  // A line that cannot legally be filed (no PAN / no section) is flagged first.
  if (panMissing || sectionMissing) return "Missing"
  if (deposited <= TOL) return challanInPeriod ? "Paid but Unallocated" : "Pending"
  if (deposited + TOL < deducted) return "Challan Mismatch"
  // Fully deposited from here on.
  if (!bankPosted) return "Challan Mismatch"
  if (!returned) return "Pending"
  if (!certified) return "Certificate Mismatch"
  return "Matched"
}

/**
 * Build the document-level trace for a financial year + direction. When a
 * `quarter` is given only that quarter's months are traced. Receivable TDS has
 * no deposit/return/certificate obligation; it is traced through the customer
 * receipt ledger instead (received vs outstanding).
 */
export async function tdsTraceReconciliation(
  financialYear: string,
  direction: TdsDirection,
  quarter?: TdsQuarter | null,
): Promise<{
  financial_year: string
  direction: TdsDirection
  quarter: TdsQuarter | null
  rows: TdsTraceRow[]
  totals: { deducted: number; deposited: number; returned: number; certified: number; matched: number; exceptions: number }
  status_counts: Record<string, number>
}> {
  await ensureTdsComplianceSchema()
  const dir = normDirection(direction)
  const periods = quarter ? monthsOfQuarter(quarter, financialYear) : monthsOfFy(financialYear)

  // Receivable: map the customer ledger onto trace rows so one reconciliation
  // surface serves every direction.
  if (!isDeductorDirection(dir)) {
    const ledger = await tdsReceivableLedger(financialYear)
    const rows: TdsTraceRow[] = ledger.rows
      .filter((r) => (quarter ? r.quarter === quarter : true))
      .map((r) => ({
        source_module: r.source_module,
        source_txn_id: r.invoice_id,
        source_ref: r.invoice_ref,
        source_href: sourceHref(r.source_module, r.invoice_id),
        doc_date: r.invoice_date,
        quarter: r.quarter as TdsQuarter,
        party_id: r.party_id,
        party_name: r.customer,
        party_href: partyHref(r.party_id),
        pan: r.pan,
        pan_status: r.pan ? "Valid" : "Missing",
        section: r.section,
        base: r.base,
        deducted: r.tds,
        filed: true,
        filing_id: null,
        deposited: round2(r.received + r.adjusted),
        balance: r.outstanding,
        challan_ref: r.certificate_ref || "",
        bank_posted: r.received + r.adjusted > TOL,
        bank_voucher: null,
        returned: false,
        return_id: null,
        certified: !!r.certificate_ref,
        certificate_id: r.certificate_ref,
        status:
          r.outstanding <= TOL ? "Received" : r.received + r.adjusted > TOL ? "Outstanding" : "Outstanding",
        dup_key: `${r.source_module}|${r.invoice_id}|${r.party_id}|${r.section}`,
      }))
    return finalize(financialYear, dir, quarter ?? null, rows)
  }

  // Deductor: gather derived detail with coverage, challan postings, filed
  // quarters and issued certificates — all from existing stores.
  const [returns, certs] = await Promise.all([listTdsReturns(dir), listCertificates(dir, financialYear)])
  const filedQuarters = new Set(
    returns
      .filter((r) => r.financial_year === financialYear && ["Filed", "Under Review", "Payment Pending"].includes(r.status))
      .map((r) => r.quarter),
  )
  const returnIdByQuarter = new Map<string, string>()
  for (const r of returns) {
    if (r.financial_year === financialYear && filedQuarters.has(r.quarter) && !returnIdByQuarter.has(r.quarter)) {
      returnIdByQuarter.set(r.quarter, r.return_id)
    }
  }
  // Certificate presence keyed by party + quarter (Form 16 is annual → all quarters).
  const certByPartyQuarter = new Map<string, string>()
  for (const c of certs) {
    const key = (q: string) => `${(c.party_name || "").toLowerCase()}|${q}`
    if (c.quarter) certByPartyQuarter.set(key(c.quarter), c.certificate_id)
    else for (const q of ["Q1", "Q2", "Q3", "Q4"]) certByPartyQuarter.set(key(q), c.certificate_id)
  }

  const rows: TdsTraceRow[] = []
  for (const period of periods) {
    const q = quarterOfPeriod(period)
    const posting = await challanPostingForPeriod(dir, period)
    const detail = (await tdsDetail(period, dir, { coverage: true })) as any[]
    for (const r of detail) {
      const deducted = round2(num(r.tds))
      if (deducted <= 0) continue
      const deposited = round2(num(r.paid))
      const panMissing = !!(r.no_pan || r.pan_status === "Missing" || r.pan_status === "Invalid")
      const sectionMissing = !r.section || r.section === "Unspecified"
      const returned = filedQuarters.has(q)
      const certId = certByPartyQuarter.get(`${String(r.party_name || "").toLowerCase()}|${q}`) || null
      const status = deductorStatus({
        deducted,
        deposited,
        challanInPeriod: posting.hasChallan,
        bankPosted: posting.posted,
        returned,
        certified: !!certId,
        panMissing,
        sectionMissing,
      })
      rows.push({
        source_module: r.source,
        source_txn_id: r.doc_id,
        source_ref: r.doc_ref || r.doc_id,
        source_href: sourceHref(r.source, r.doc_id),
        doc_date: String(r.doc_date).slice(0, 10),
        quarter: q,
        party_id: String(r.party_id || ""),
        party_name: r.party_name || "—",
        party_href: partyHref(String(r.party_id || "")),
        pan: r.pan || "",
        pan_status: r.pan_status || "Missing",
        section: r.section || "Unspecified",
        base: round2(num(r.base)),
        deducted,
        filed: true,
        filing_id: null,
        deposited,
        balance: round2(num(r.balance)),
        challan_ref: r.challan || "",
        bank_posted: posting.posted && deposited > TOL,
        bank_voucher: posting.voucher,
        returned,
        return_id: returned ? returnIdByQuarter.get(q) || null : null,
        certified: !!certId,
        certificate_id: certId,
        status,
        dup_key: `${r.source}|${r.doc_id}|${r.party_id || r.party_name}|${r.section}`,
      })
    }
  }

  rows.sort((a, b) => b.deducted - a.deducted || a.source_ref.localeCompare(b.source_ref))
  return finalize(financialYear, dir, quarter ?? null, rows)
}

function finalize(financialYear: string, direction: TdsDirection, quarter: TdsQuarter | null, rows: TdsTraceRow[]) {
  const status_counts: Record<string, number> = {}
  for (const r of rows) status_counts[r.status] = (status_counts[r.status] || 0) + 1
  const matched = rows.filter((r) => r.status === "Matched" || r.status === "Received").length
  const totals = {
    deducted: round2(rows.reduce((s, r) => s + r.deducted, 0)),
    deposited: round2(rows.reduce((s, r) => s + r.deposited, 0)),
    returned: round2(rows.filter((r) => r.returned).reduce((s, r) => s + r.deducted, 0)),
    certified: round2(rows.filter((r) => r.certified).reduce((s, r) => s + r.deducted, 0)),
    matched,
    exceptions: rows.length - matched,
  }
  return { financial_year: financialYear, direction, quarter, rows, totals, status_counts }
}

/** Whether a period has a challan and whether that challan is posted to the GL. */
async function challanPostingForPeriod(
  direction: TdsDirection,
  period: string,
): Promise<{ hasChallan: boolean; posted: boolean; voucher: string | null }> {
  const rows = (await query(
    `SELECT posting_status, voucher_no FROM tds_challans WHERE direction = ? AND period = ?`,
    [normDirection(direction), period],
  ).catch(() => [])) as any[]
  if (!rows.length) return { hasChallan: false, posted: false, voucher: null }
  const postedRow = rows.find((r) => String(r.posting_status) === "Posted" && r.voucher_no)
  return { hasChallan: true, posted: !!postedRow, voucher: postedRow?.voucher_no ?? null }
}

export type TdsDuplicateGroup = {
  dup_key: string
  source_module: string
  source_txn_id: string
  party_name: string
  section: string
  occurrences: number
  total_tds: number
  refs: string[]
}

/**
 * Duplicate control (Phase 45): every TDS event must be unique on
 * (source module, source txn id, deductee, section). Because deductions are
 * derived one-per-source-document this normally returns an empty list — the
 * report exists to PROVE that invariant and to catch any source that emitted a
 * document twice. Returns only the groups that violate uniqueness.
 */
export async function detectTdsDuplicates(
  financialYear: string,
  direction: TdsDirection,
): Promise<{ financial_year: string; direction: TdsDirection; scanned: number; duplicates: TdsDuplicateGroup[] }> {
  const { rows } = await tdsTraceReconciliation(financialYear, direction, null)
  const groups = new Map<string, TdsDuplicateGroup>()
  for (const r of rows) {
    const g = groups.get(r.dup_key) || {
      dup_key: r.dup_key,
      source_module: r.source_module,
      source_txn_id: r.source_txn_id,
      party_name: r.party_name,
      section: r.section,
      occurrences: 0,
      total_tds: 0,
      refs: [],
    }
    g.occurrences += 1
    g.total_tds = round2(g.total_tds + r.deducted)
    g.refs.push(r.source_ref)
    groups.set(r.dup_key, g)
  }
  const duplicates = Array.from(groups.values()).filter((g) => g.occurrences > 1)
  return { financial_year: financialYear, direction, scanned: rows.length, duplicates }
}
