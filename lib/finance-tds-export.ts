import "server-only"
import { tdsRawData } from "@/lib/finance-tds-raw"
import { tdsExceptionReport } from "@/lib/finance-tds-exceptions"
import {
  tdsLiability,
  tdsReconciliation,
  listChallans,
  listTdsReturns,
  listCertificates,
  deducteeMaster,
  getDeductorIdentity,
} from "@/lib/finance-tds-compliance"
import type { TdsDirection } from "@/lib/finance-tds-filing"

/**
 * TDS Export + CA Review package (Phases 61–62).
 *
 * A read-only presentation layer over the existing engines. Nothing here
 * recomputes TDS — each dataset is assembled from the same functions the UI
 * stages already use (raw register, liability, reconciliation, challans,
 * returns, certificates, deductee master, exception report), then flattened
 * into tabular `{ columns, rows }` shapes the client can hand straight to the
 * shared `exportRowsToExcel` helper. The CA package simply bundles every
 * dataset plus a cover summary so a chartered accountant gets the whole
 * financial year in one download.
 */

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

export type ExportColumnSpec = { key: string; header: string }
export type ExportDataset = {
  key: string
  label: string
  columns: ExportColumnSpec[]
  rows: Record<string, unknown>[]
}

export const TDS_EXPORT_KINDS = [
  "monthly",
  "quarterly",
  "section",
  "deductee",
  "challan",
  "return",
  "raw",
  "reconciliation",
  "exception",
] as const
export type TdsExportKind = (typeof TDS_EXPORT_KINDS)[number]

export const TDS_EXPORT_LABELS: Record<TdsExportKind, string> = {
  monthly: "Monthly TDS Summary",
  quarterly: "Quarterly TDS Summary",
  section: "Section-wise Summary",
  deductee: "Deductee-wise Summary",
  challan: "Challan Register",
  return: "Return Register",
  raw: "Raw TDS Data",
  reconciliation: "Reconciliation Statement",
  exception: "Exception Report",
}

// --- individual dataset builders ------------------------------------------

async function monthlyDataset(fy: string, dir: TdsDirection): Promise<ExportDataset> {
  const liability = await tdsLiability(fy, dir)
  return {
    key: "monthly",
    label: TDS_EXPORT_LABELS.monthly,
    columns: [
      { key: "period", header: "Month" },
      { key: "quarter", header: "Quarter" },
      { key: "base", header: "Taxable Amount" },
      { key: "deducted", header: "TDS Deducted" },
      { key: "interest", header: "Interest" },
      { key: "late_fee", header: "Late Fee" },
      { key: "total_liability", header: "Total Liability" },
      { key: "deposited", header: "Deposited" },
      { key: "balance", header: "Balance" },
      { key: "due_date", header: "Due Date" },
      { key: "status", header: "Status" },
    ],
    rows: liability.rows as unknown as Record<string, unknown>[],
  }
}

async function quarterlyDataset(fy: string, dir: TdsDirection): Promise<ExportDataset> {
  const liability = await tdsLiability(fy, dir)
  return {
    key: "quarterly",
    label: TDS_EXPORT_LABELS.quarterly,
    columns: [
      { key: "quarter", header: "Quarter" },
      { key: "base", header: "Taxable Amount" },
      { key: "tds", header: "TDS" },
      { key: "payments", header: "Payments" },
      { key: "balance", header: "Balance" },
      { key: "return_form", header: "Return Form" },
      { key: "return_status", header: "Return Status" },
      { key: "return_due_date", header: "Return Due Date" },
    ],
    rows: liability.quarterly as unknown as Record<string, unknown>[],
  }
}

async function sectionDataset(fy: string, dir: TdsDirection): Promise<ExportDataset> {
  const raw = await tdsRawData(fy, { direction: dir })
  const map = new Map<string, { section: string; payment_type: string; base: number; tds: number; count: number }>()
  for (const r of raw.rows) {
    const key = r.section || "—"
    const prev = map.get(key) || { section: key, payment_type: r.payment_type, base: 0, tds: 0, count: 0 }
    prev.base = round2(prev.base + r.gross)
    prev.tds = round2(prev.tds + r.tds)
    prev.count += 1
    map.set(key, prev)
  }
  const rows = Array.from(map.values())
    .map((r) => ({ ...r, rate: r.base > 0 ? round2((r.tds / r.base) * 100) : 0 }))
    .sort((a, b) => b.tds - a.tds)
  return {
    key: "section",
    label: TDS_EXPORT_LABELS.section,
    columns: [
      { key: "section", header: "Section" },
      { key: "payment_type", header: "Nature of Payment" },
      { key: "count", header: "Transactions" },
      { key: "base", header: "Taxable Amount" },
      { key: "rate", header: "Effective Rate %" },
      { key: "tds", header: "TDS" },
    ],
    rows: rows as unknown as Record<string, unknown>[],
  }
}

async function deducteeDataset(fy: string, dir: TdsDirection): Promise<ExportDataset> {
  const master = await deducteeMaster(fy, dir)
  const rows = master.deductees.map((d) => ({
    deductee_id: d.deductee_id,
    party_name: d.party_name,
    pan: d.pan,
    pan_status: d.pan_status,
    party_type: d.party_type,
    resident_status: d.resident_status,
    payment_type: d.payment_type,
    sections: d.sections.join(", "),
    doc_count: d.doc_count,
    base: d.base,
    rate: d.rate,
    tds: d.tds,
  }))
  return {
    key: "deductee",
    label: TDS_EXPORT_LABELS.deductee,
    columns: [
      { key: "deductee_id", header: "Deductee ID" },
      { key: "party_name", header: "Name" },
      { key: "pan", header: "PAN" },
      { key: "pan_status", header: "PAN Status" },
      { key: "party_type", header: "Entity Type" },
      { key: "resident_status", header: "Residence" },
      { key: "payment_type", header: "Nature of Payment" },
      { key: "sections", header: "Sections" },
      { key: "doc_count", header: "Documents" },
      { key: "base", header: "Taxable Amount" },
      { key: "rate", header: "Effective Rate %" },
      { key: "tds", header: "TDS" },
    ],
    rows: rows as unknown as Record<string, unknown>[],
  }
}

async function challanDataset(fy: string, dir: TdsDirection): Promise<ExportDataset> {
  const challans = await listChallans(dir, fy)
  return {
    key: "challan",
    label: TDS_EXPORT_LABELS.challan,
    columns: [
      { key: "challan_id", header: "Challan ID" },
      { key: "period", header: "Period" },
      { key: "quarter", header: "Quarter" },
      { key: "bsr_code", header: "BSR Code" },
      { key: "challan_no", header: "Challan No" },
      { key: "payment_date", header: "Payment Date" },
      { key: "tds_amount", header: "TDS" },
      { key: "interest", header: "Interest" },
      { key: "late_fee", header: "Late Fee" },
      { key: "total_amount", header: "Total" },
      { key: "payment_mode", header: "Mode" },
      { key: "status", header: "Status" },
    ],
    rows: challans as unknown as Record<string, unknown>[],
  }
}

async function returnDataset(fy: string, dir: TdsDirection): Promise<ExportDataset> {
  const returns = (await listTdsReturns(dir)).filter((r) => r.financial_year === fy)
  return {
    key: "return",
    label: TDS_EXPORT_LABELS.return,
    columns: [
      { key: "return_id", header: "Return ID" },
      { key: "form_type", header: "Form" },
      { key: "quarter", header: "Quarter" },
      { key: "total_base", header: "Taxable Amount" },
      { key: "total_deducted", header: "TDS Deducted" },
      { key: "total_deposited", header: "Deposited" },
      { key: "deductee_count", header: "Deductees" },
      { key: "status", header: "Status" },
      { key: "token_no", header: "Token No" },
      { key: "revision_no", header: "Revision" },
      { key: "filed_at", header: "Filed At" },
    ],
    rows: returns as unknown as Record<string, unknown>[],
  }
}

async function rawDataset(fy: string, dir: TdsDirection): Promise<ExportDataset> {
  const raw = await tdsRawData(fy, { direction: dir })
  return {
    key: "raw",
    label: TDS_EXPORT_LABELS.raw,
    columns: [
      { key: "month", header: "Month" },
      { key: "quarter", header: "Quarter" },
      { key: "tds_type", header: "TDS Type" },
      { key: "source", header: "Source" },
      { key: "doc_ref", header: "Document" },
      { key: "doc_date", header: "Date" },
      { key: "deductee_name", header: "Deductee" },
      { key: "pan", header: "PAN" },
      { key: "pan_status", header: "PAN Status" },
      { key: "section", header: "Section" },
      { key: "payment_type", header: "Nature of Payment" },
      { key: "resident_status", header: "Residence" },
      { key: "gross", header: "Gross" },
      { key: "rate", header: "Rate %" },
      { key: "tds", header: "TDS" },
      { key: "interest", header: "Interest" },
      { key: "late_fee", header: "Late Fee" },
      { key: "total_liability", header: "Total Liability" },
      { key: "paid", header: "Paid" },
      { key: "balance", header: "Balance" },
      { key: "challan", header: "Challan" },
      { key: "return_type", header: "Return" },
      { key: "return_status", header: "Return Status" },
    ],
    rows: raw.rows as unknown as Record<string, unknown>[],
  }
}

async function reconciliationDataset(fy: string, dir: TdsDirection): Promise<ExportDataset> {
  const recon = await tdsReconciliation(fy, dir)
  return {
    key: "reconciliation",
    label: TDS_EXPORT_LABELS.reconciliation,
    columns: [
      { key: "quarter", header: "Quarter" },
      { key: "deducted", header: "Deducted (Books)" },
      { key: "deposited", header: "Deposited (Challans)" },
      { key: "returned", header: "Returned (Filed)" },
      { key: "certified", header: "Certified" },
      { key: "deposit_variance", header: "Deposit Variance" },
      { key: "return_variance", header: "Return Variance" },
      { key: "status", header: "Status" },
    ],
    rows: recon.rows as unknown as Record<string, unknown>[],
  }
}

async function exceptionDataset(fy: string, dir: TdsDirection): Promise<ExportDataset> {
  const report = await tdsExceptionReport(fy, dir)
  const rows = report.categories.flatMap((c) =>
    c.rows.map((r) => ({
      category: c.label,
      severity: c.severity,
      reference: r.ref,
      deductee: r.label,
      section: r.section ?? "",
      period: r.period ?? r.quarter ?? "",
      amount: r.amount,
      detail: r.detail,
    })),
  )
  return {
    key: "exception",
    label: TDS_EXPORT_LABELS.exception,
    columns: [
      { key: "category", header: "Exception" },
      { key: "severity", header: "Severity" },
      { key: "reference", header: "Reference" },
      { key: "deductee", header: "Deductee / Period" },
      { key: "section", header: "Section" },
      { key: "period", header: "Period" },
      { key: "amount", header: "Amount" },
      { key: "detail", header: "Detail" },
    ],
    rows: rows as unknown as Record<string, unknown>[],
  }
}

const BUILDERS: Record<TdsExportKind, (fy: string, dir: TdsDirection) => Promise<ExportDataset>> = {
  monthly: monthlyDataset,
  quarterly: quarterlyDataset,
  section: sectionDataset,
  deductee: deducteeDataset,
  challan: challanDataset,
  return: returnDataset,
  raw: rawDataset,
  reconciliation: reconciliationDataset,
  exception: exceptionDataset,
}

/** Build a single export dataset (Phase 61). */
export async function tdsExportDataset(
  kind: TdsExportKind,
  fy: string,
  direction: TdsDirection,
): Promise<ExportDataset> {
  const builder = BUILDERS[kind]
  if (!builder) throw new Error(`Unknown export dataset: ${kind}`)
  return builder(fy, direction)
}

export type TdsCaPackage = {
  financial_year: string
  direction: TdsDirection
  generated_at: string
  deductor: { tan: string; pan: string; name: string; address: string }
  summary: {
    total_base: number
    total_tds: number
    total_deposited: number
    total_balance: number
    return_count: number
    certificate_count: number
    exceptions: number
    exception_exposure: number
    reconciliation_status: string
  }
  datasets: ExportDataset[]
}

/**
 * One-click CA review package (Phase 62): every register for the year plus a
 * cover summary, assembled purely from the existing engines.
 */
export async function tdsCaPackage(fy: string, direction: TdsDirection): Promise<TdsCaPackage> {
  const [deductor, liability, recon, returns, certificates, exceptions, datasets] = await Promise.all([
    getDeductorIdentity(),
    tdsLiability(fy, direction),
    tdsReconciliation(fy, direction),
    listTdsReturns(direction),
    listCertificates(direction, fy),
    tdsExceptionReport(fy, direction),
    Promise.all(TDS_EXPORT_KINDS.map((k) => tdsExportDataset(k, fy, direction))),
  ])

  const fyReturns = returns.filter((r) => r.financial_year === fy)
  const mismatch = recon.rows.some((r) => r.status === "Mismatch")

  return {
    financial_year: fy,
    direction,
    generated_at: new Date().toISOString(),
    deductor,
    summary: {
      total_base: liability.totals.base,
      total_tds: liability.totals.deducted,
      total_deposited: liability.totals.deposited,
      total_balance: liability.totals.balance,
      return_count: fyReturns.length,
      certificate_count: certificates.length,
      exceptions: exceptions.totals.total_exceptions,
      exception_exposure: exceptions.totals.exposure,
      reconciliation_status: mismatch ? "Mismatch" : "Balanced",
    },
    datasets,
  }
}
