import "server-only"
import { query } from "@/lib/db"
import { MANUAL_JOURNAL_SOURCE } from "@/lib/finance-journal"

/**
 * Journal Exports (Phase 51).
 *
 * A read-only presentation layer over the ONE accounting engine — the
 * `journal_entries` table that every module (manual journals plus system
 * postings from sales, purchases, expenses, payroll, freelance, GST, TDS…)
 * writes into. Nothing here recomputes or re-posts anything; each dataset is a
 * grouped/flattened view of the same rows the Journal Entries screen lists,
 * shaped into `{ columns, rows }` the client hands straight to the shared
 * `exportRowsToExcel` helper.
 *
 * Five datasets, all honouring the same filters (financial year, source,
 * search, date range) so an export always matches what the user is looking at:
 *   register     — one row per voucher (the classic journal register)
 *   detail       — one row per posting line (full ledger-line detail)
 *   account      — account-wise totals (debit/credit/net per account head)
 *   voucher      — voucher-type-wise totals
 *   period       — month-wise totals
 */

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

export type ExportColumnSpec = { key: string; header: string }
export type JournalExportDataset = {
  key: string
  label: string
  columns: ExportColumnSpec[]
  rows: Record<string, unknown>[]
}

export const JOURNAL_EXPORT_KINDS = ["register", "detail", "account", "voucher", "period"] as const
export type JournalExportKind = (typeof JOURNAL_EXPORT_KINDS)[number]

export const JOURNAL_EXPORT_LABELS: Record<JournalExportKind, string> = {
  register: "Journal Register",
  detail: "Journal Detail",
  account: "Account-wise Journal",
  voucher: "Voucher-wise Journal",
  period: "Period-wise Journal",
}

export type JournalExportFilters = {
  financialYear?: string | null
  /** "all" (default) | "manual" (source_module = Manual) | "system" (everything else). */
  source?: "all" | "manual" | "system" | null
  search?: string | null
  from?: string | null
  to?: string | null
}

/**
 * Build the shared WHERE clause + params for every dataset so all five stay in
 * lock-step with the on-screen filters. Uses a stable voucher key that falls
 * back to the per-line id for legacy rows that predate voucher grouping.
 */
function buildWhere(filters: JournalExportFilters, alias = ""): { where: string; params: any[] } {
  const p = alias ? `${alias}.` : ""
  const clauses: string[] = []
  const params: any[] = []

  const fy = filters.financialYear?.trim()
  if (fy) {
    clauses.push(`${p}financial_year = ?`)
    params.push(fy)
  }

  if (filters.source === "manual") {
    clauses.push(`${p}source_module = ?`)
    params.push(MANUAL_JOURNAL_SOURCE)
  } else if (filters.source === "system") {
    clauses.push(`(${p}source_module IS NULL OR ${p}source_module <> ?)`)
    params.push(MANUAL_JOURNAL_SOURCE)
  }

  const search = filters.search?.trim()
  if (search) {
    const like = `%${search}%`
    clauses.push(
      `(${p}voucher_no LIKE ? OR ${p}journal_entry_id LIKE ? OR ${p}account_name LIKE ? OR ${p}party_name LIKE ? OR ${p}narration LIKE ? OR ${p}reference_no LIKE ?)`,
    )
    params.push(like, like, like, like, like, like)
  }

  const from = filters.from?.trim()
  if (from) {
    clauses.push(`${p}journal_date >= ?`)
    params.push(from)
  }
  const to = filters.to?.trim()
  if (to) {
    clauses.push(`${p}journal_date <= ?`)
    params.push(to)
  }

  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params }
}

const VOUCHER_KEY = "COALESCE(NULLIF(voucher_no, ''), journal_entry_id)"

// --- dataset builders -------------------------------------------------------

async function registerDataset(filters: JournalExportFilters): Promise<JournalExportDataset> {
  const { where, params } = buildWhere(filters)
  const rows = (await query(
    `SELECT ${VOUCHER_KEY} AS voucher_no,
            MIN(journal_date)               AS journal_date,
            MIN(financial_year)             AS financial_year,
            MIN(voucher_type)               AS voucher_type,
            MIN(source_module)              AS source_module,
            MIN(reference_no)               AS reference_no,
            MIN(narration)                  AS narration,
            MIN(approval_status)            AS approval_status,
            MIN(posting_status)             AS posting_status,
            COUNT(*)                        AS line_count,
            ROUND(SUM(debit), 2)            AS total_debit,
            ROUND(SUM(credit), 2)           AS total_credit
       FROM journal_entries
       ${where}
      GROUP BY ${VOUCHER_KEY}
      ORDER BY journal_date DESC, voucher_no DESC`,
    params,
  )) as any[]
  return {
    key: "register",
    label: JOURNAL_EXPORT_LABELS.register,
    columns: [
      { key: "voucher_no", header: "Journal Entry ID" },
      { key: "journal_date", header: "Date" },
      { key: "financial_year", header: "Financial Year" },
      { key: "voucher_type", header: "Voucher Type" },
      { key: "source_module", header: "Source" },
      { key: "reference_no", header: "Reference" },
      { key: "narration", header: "Narration" },
      { key: "line_count", header: "Lines" },
      { key: "total_debit", header: "Debit" },
      { key: "total_credit", header: "Credit" },
      { key: "approval_status", header: "Status" },
      { key: "posting_status", header: "Posting" },
    ],
    rows: rows as Record<string, unknown>[],
  }
}

async function detailDataset(filters: JournalExportFilters): Promise<JournalExportDataset> {
  const { where, params } = buildWhere(filters)
  const rows = (await query(
    `SELECT ${VOUCHER_KEY} AS voucher_no, journal_entry_id, journal_date, financial_year,
            voucher_type, reference_no, account_name, account_group, account_type,
            party_name, project_name, cost_centre, debit, credit, gst_amount, tds_amount,
            narration, payment_mode, cheque_utr_reference, source_module, source_reference,
            approval_status, posting_status
       FROM journal_entries
       ${where}
      ORDER BY journal_date DESC, voucher_no DESC, id ASC`,
    params,
  )) as any[]
  return {
    key: "detail",
    label: JOURNAL_EXPORT_LABELS.detail,
    columns: [
      { key: "voucher_no", header: "Journal Entry ID" },
      { key: "journal_date", header: "Date" },
      { key: "financial_year", header: "Financial Year" },
      { key: "voucher_type", header: "Voucher Type" },
      { key: "reference_no", header: "Reference" },
      { key: "account_name", header: "Account" },
      { key: "account_group", header: "Account Group" },
      { key: "account_type", header: "Account Type" },
      { key: "party_name", header: "Party" },
      { key: "project_name", header: "Project" },
      { key: "cost_centre", header: "Cost Centre" },
      { key: "debit", header: "Debit" },
      { key: "credit", header: "Credit" },
      { key: "gst_amount", header: "GST" },
      { key: "tds_amount", header: "TDS" },
      { key: "narration", header: "Narration" },
      { key: "payment_mode", header: "Payment Mode" },
      { key: "cheque_utr_reference", header: "Cheque / UTR" },
      { key: "source_module", header: "Source" },
      { key: "source_reference", header: "Source Reference" },
      { key: "approval_status", header: "Status" },
      { key: "posting_status", header: "Posting" },
    ],
    rows: rows as Record<string, unknown>[],
  }
}

async function accountDataset(filters: JournalExportFilters): Promise<JournalExportDataset> {
  const { where, params } = buildWhere(filters, "je")
  const rows = (await query(
    `SELECT je.account_id,
            coa.account_code                                    AS account_code,
            MIN(je.account_name)                                AS account_name,
            MIN(je.account_group)                               AS account_group,
            MIN(je.account_type)                                AS account_type,
            COUNT(DISTINCT COALESCE(NULLIF(je.voucher_no, ''), je.journal_entry_id)) AS voucher_count,
            COUNT(*)                                            AS line_count,
            ROUND(SUM(je.debit), 2)                             AS total_debit,
            ROUND(SUM(je.credit), 2)                            AS total_credit,
            ROUND(SUM(je.debit) - SUM(je.credit), 2)            AS net_amount
       FROM journal_entries je
       LEFT JOIN chart_of_accounts coa ON coa.account_id = je.account_id
       ${where}
      GROUP BY je.account_id, coa.account_code
      ORDER BY account_group, account_name`,
    params,
  )) as any[]
  return {
    key: "account",
    label: JOURNAL_EXPORT_LABELS.account,
    columns: [
      { key: "account_code", header: "Account Code" },
      { key: "account_name", header: "Account" },
      { key: "account_group", header: "Account Group" },
      { key: "account_type", header: "Account Type" },
      { key: "voucher_count", header: "Vouchers" },
      { key: "line_count", header: "Lines" },
      { key: "total_debit", header: "Debit" },
      { key: "total_credit", header: "Credit" },
      { key: "net_amount", header: "Net (Dr - Cr)" },
    ],
    rows: rows as Record<string, unknown>[],
  }
}

async function voucherDataset(filters: JournalExportFilters): Promise<JournalExportDataset> {
  const { where, params } = buildWhere(filters)
  const rows = (await query(
    `SELECT COALESCE(NULLIF(voucher_type, ''), 'Journal')  AS voucher_type,
            COUNT(DISTINCT ${VOUCHER_KEY})                 AS voucher_count,
            COUNT(*)                                       AS line_count,
            ROUND(SUM(debit), 2)                           AS total_debit,
            ROUND(SUM(credit), 2)                          AS total_credit,
            ROUND(SUM(debit) - SUM(credit), 2)             AS net_amount
       FROM journal_entries
       ${where}
      GROUP BY COALESCE(NULLIF(voucher_type, ''), 'Journal')
      ORDER BY total_debit DESC`,
    params,
  )) as any[]
  return {
    key: "voucher",
    label: JOURNAL_EXPORT_LABELS.voucher,
    columns: [
      { key: "voucher_type", header: "Voucher Type" },
      { key: "voucher_count", header: "Vouchers" },
      { key: "line_count", header: "Lines" },
      { key: "total_debit", header: "Debit" },
      { key: "total_credit", header: "Credit" },
      { key: "net_amount", header: "Net (Dr - Cr)" },
    ],
    rows: rows as Record<string, unknown>[],
  }
}

async function periodDataset(filters: JournalExportFilters): Promise<JournalExportDataset> {
  const { where, params } = buildWhere(filters)
  const rows = (await query(
    `SELECT DATE_FORMAT(journal_date, '%Y-%m')            AS period,
            MIN(financial_year)                           AS financial_year,
            COUNT(DISTINCT ${VOUCHER_KEY})                AS voucher_count,
            COUNT(*)                                      AS line_count,
            ROUND(SUM(debit), 2)                          AS total_debit,
            ROUND(SUM(credit), 2)                         AS total_credit,
            ROUND(SUM(debit) - SUM(credit), 2)            AS net_amount
       FROM journal_entries
       ${where}
      GROUP BY DATE_FORMAT(journal_date, '%Y-%m')
      ORDER BY period DESC`,
    params,
  )) as any[]
  return {
    key: "period",
    label: JOURNAL_EXPORT_LABELS.period,
    columns: [
      { key: "period", header: "Period (YYYY-MM)" },
      { key: "financial_year", header: "Financial Year" },
      { key: "voucher_count", header: "Vouchers" },
      { key: "line_count", header: "Lines" },
      { key: "total_debit", header: "Debit" },
      { key: "total_credit", header: "Credit" },
      { key: "net_amount", header: "Net (Dr - Cr)" },
    ],
    rows: rows as Record<string, unknown>[],
  }
}

const BUILDERS: Record<JournalExportKind, (f: JournalExportFilters) => Promise<JournalExportDataset>> = {
  register: registerDataset,
  detail: detailDataset,
  account: accountDataset,
  voucher: voucherDataset,
  period: periodDataset,
}

/** Build a single journal export dataset (Phase 51). */
export async function journalExportDataset(
  kind: JournalExportKind,
  filters: JournalExportFilters,
): Promise<JournalExportDataset> {
  const builder = BUILDERS[kind]
  if (!builder) throw new Error(`Unknown export dataset: ${kind}`)
  const dataset = await builder(filters)
  // Round any straggler numeric aggregates defensively so the sheet never shows
  // a floating-point tail from SUM().
  dataset.rows = dataset.rows.map((r) => {
    const out: Record<string, unknown> = { ...r }
    for (const c of dataset.columns) {
      const v = out[c.key]
      if (typeof v === "number") out[c.key] = round2(v)
    }
    return out
  })
  return dataset
}
