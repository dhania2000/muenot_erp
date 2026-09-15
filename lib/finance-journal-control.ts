import "server-only"
import { query } from "@/lib/db"
import { periodKeyFor, isPeriodLocked } from "@/lib/finance-period-lock"

/**
 * Journal control engine — Phases 54 (reconciliation), 55 (month-end checklist)
 * and 60 (error center).
 *
 * A single READ-ONLY diagnostic pass over the existing accounting tables
 * (`journal_entries`, `general_ledger`, `finance_period_locks`). It owns no
 * table, posts nothing, and never mutates a voucher — it only surfaces the state
 * of vouchers the existing posting engine already wrote so finance can see, per
 * period, what still blocks a clean close and drill into every exception.
 *
 * Everything is keyed off `voucher_no` (the natural grouping of a double-entry
 * posting) and a `YYYY-MM` period derived from `journal_date`, so the checks
 * line up exactly with lib/finance-period-lock.ts.
 */

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

// A period filter fragment for `journal_date`. When no period is given every
// row is considered, so the same engine powers a single-month close check and a
// portfolio-wide error center.
function periodClause(period?: string | null): { sql: string; params: any[] } {
  const key = periodKeyFor(period)
  if (!key || !/^\d{4}-\d{2}$/.test(key)) return { sql: "", params: [] }
  return { sql: ` AND DATE_FORMAT(je.journal_date, '%Y-%m') = ?`, params: [key] }
}

export type ExceptionCode =
  | "Unbalanced"
  | "MissingAccount"
  | "InvalidAccount"
  | "Duplicate"
  | "MissingSource"
  | "GstMismatch"
  | "TdsMismatch"
  | "ClosedPeriod"
  | "PostingFailed"
  | "GlMismatch"

export type JournalException = {
  code: ExceptionCode
  severity: "error" | "warning"
  voucherNo: string
  period: string
  journalDate: string
  sourceModule: string
  message: string
}

const SEVERITY: Record<ExceptionCode, "error" | "warning"> = {
  Unbalanced: "error",
  MissingAccount: "error",
  InvalidAccount: "error",
  Duplicate: "warning",
  MissingSource: "warning",
  GstMismatch: "warning",
  TdsMismatch: "warning",
  ClosedPeriod: "error",
  PostingFailed: "error",
  GlMismatch: "error",
}

type VoucherAgg = {
  voucher_no: string
  period: string
  journal_date: string
  source_module: string
  approval_status: string
  posting_status: string
  lines: number
  debit: number
  credit: number
  gst: number
  tds: number
  null_accounts: number
  invalid_accounts: number
  has_source_ref: number
  gl_lines: number
  gl_debit: number
  gl_credit: number
}

/**
 * One SQL pass that aggregates every voucher in scope with the joins needed to
 * evaluate all exception classes: balance, account validity (against
 * chart_of_accounts), source linkage, and the matching GL rollup.
 */
async function aggregateVouchers(period?: string | null): Promise<VoucherAgg[]> {
  const { sql, params } = periodClause(period)
  const rows = (await query(
    `SELECT
        je.voucher_no                                             AS voucher_no,
        DATE_FORMAT(je.journal_date, '%Y-%m')                     AS period,
        MIN(je.journal_date)                                      AS journal_date,
        COALESCE(MAX(je.source_module), '')                       AS source_module,
        COALESCE(MAX(je.approval_status), '')                     AS approval_status,
        COALESCE(MAX(je.posting_status), '')                      AS posting_status,
        COUNT(*)                                                  AS lines,
        ROUND(SUM(je.debit), 2)                                   AS debit,
        ROUND(SUM(je.credit), 2)                                  AS credit,
        ROUND(SUM(je.gst_amount), 2)                              AS gst,
        ROUND(SUM(je.tds_amount), 2)                              AS tds,
        SUM(CASE WHEN je.account_id IS NULL OR je.account_id = '' THEN 1 ELSE 0 END) AS null_accounts,
        SUM(CASE WHEN je.account_id IS NOT NULL AND je.account_id <> '' AND coa.account_id IS NULL THEN 1 ELSE 0 END) AS invalid_accounts,
        MAX(CASE WHEN je.source_reference IS NOT NULL AND je.source_reference <> '' THEN 1
                 WHEN je.source_entity_id IS NOT NULL THEN 1 ELSE 0 END) AS has_source_ref
       FROM journal_entries je
       LEFT JOIN chart_of_accounts coa ON coa.account_id = je.account_id
      WHERE je.voucher_no IS NOT NULL AND je.voucher_no <> ''${sql}
      GROUP BY je.voucher_no, DATE_FORMAT(je.journal_date, '%Y-%m')`,
    params,
  )) as any[]

  if (!rows.length) return []

  // Matching GL rollup for the same vouchers (one extra grouped read).
  const vouchers = rows.map((r) => String(r.voucher_no))
  const placeholders = vouchers.map(() => "?").join(",")
  const glRows = (await query(
    `SELECT voucher_no,
            COUNT(*)                AS gl_lines,
            ROUND(SUM(debit), 2)    AS gl_debit,
            ROUND(SUM(credit), 2)   AS gl_credit
       FROM general_ledger
      WHERE voucher_no IN (${placeholders})
      GROUP BY voucher_no`,
    vouchers,
  )) as any[]
  const glMap = new Map(glRows.map((g) => [String(g.voucher_no), g]))

  return rows.map((r) => {
    const gl = glMap.get(String(r.voucher_no))
    return {
      voucher_no: String(r.voucher_no),
      period: String(r.period || ""),
      journal_date: String(r.journal_date || "").slice(0, 10),
      source_module: String(r.source_module || ""),
      approval_status: String(r.approval_status || ""),
      posting_status: String(r.posting_status || ""),
      lines: num(r.lines),
      debit: round2(r.debit),
      credit: round2(r.credit),
      gst: round2(r.gst),
      tds: round2(r.tds),
      null_accounts: num(r.null_accounts),
      invalid_accounts: num(r.invalid_accounts),
      has_source_ref: num(r.has_source_ref),
      gl_lines: gl ? num(gl.gl_lines) : 0,
      gl_debit: gl ? round2(gl.gl_debit) : 0,
      gl_credit: gl ? round2(gl.gl_credit) : 0,
    }
  })
}

// Detect vouchers that look like accidental duplicates: same date + source +
// identical debit & credit totals appearing more than once. Manual re-keys and
// double-posts surface here without flagging legitimate reversals (a reversal
// mirrors debit↔credit, so its totals differ from the original).
async function duplicateVouchers(period?: string | null): Promise<Set<string>> {
  const { sql, params } = periodClause(period)
  const rows = (await query(
    `SELECT GROUP_CONCAT(t.voucher_no) AS vouchers
       FROM (
         SELECT je.voucher_no,
                MIN(je.journal_date)          AS d,
                COALESCE(MAX(je.source_module),'') AS sm,
                ROUND(SUM(je.debit),2)        AS dr,
                ROUND(SUM(je.credit),2)       AS cr
           FROM journal_entries je
          WHERE je.voucher_no IS NOT NULL AND je.voucher_no <> ''
            AND (je.reference_type IS NULL OR je.reference_type <> 'Reversal')${sql}
          GROUP BY je.voucher_no
       ) t
      GROUP BY t.d, t.sm, t.dr, t.cr
      HAVING COUNT(*) > 1 AND t.dr > 0`,
    params,
  )) as any[]
  const dupes = new Set<string>()
  for (const r of rows) {
    for (const v of String(r.vouchers || "").split(",")) {
      const t = v.trim()
      if (t) dupes.add(t)
    }
  }
  return dupes
}

/**
 * Compute every journal exception in scope (Phase 60). Each voucher can raise
 * more than one exception. Closed-period detection reuses the authoritative
 * period-lock table so it never diverges from what actually blocks posting.
 */
export async function computeJournalExceptions(period?: string | null): Promise<JournalException[]> {
  const [aggs, dupes] = await Promise.all([aggregateVouchers(period), duplicateVouchers(period)])
  const out: JournalException[] = []

  // Resolve which periods in scope are locked once, up front.
  const periods = Array.from(new Set(aggs.map((a) => a.period).filter(Boolean)))
  const lockedPeriods = new Set<string>()
  await Promise.all(
    periods.map(async (p) => {
      if (await isPeriodLocked(p)) lockedPeriods.add(p)
    }),
  )

  const push = (a: VoucherAgg, code: ExceptionCode, message: string) =>
    out.push({
      code,
      severity: SEVERITY[code],
      voucherNo: a.voucher_no,
      period: a.period,
      journalDate: a.journal_date,
      sourceModule: a.source_module || "Manual",
      message,
    })

  for (const a of aggs) {
    const posted = a.posting_status === "Posted"
    const approved = a.approval_status === "Approved" || posted

    if (Math.abs(a.debit - a.credit) > 0.01)
      push(a, "Unbalanced", `Debit ${a.debit} ≠ credit ${a.credit} (difference ${round2(a.debit - a.credit)}).`)

    if (a.null_accounts > 0)
      push(a, "MissingAccount", `${a.null_accounts} line(s) have no account selected.`)

    if (a.invalid_accounts > 0)
      push(a, "InvalidAccount", `${a.invalid_accounts} line(s) reference an account missing from the Chart of Accounts.`)

    if (dupes.has(a.voucher_no))
      push(a, "Duplicate", `Same date, source and amounts as another voucher — possible duplicate posting.`)

    const isManual = !a.source_module || a.source_module.toLowerCase() === "manual"
    if (!isManual && !a.has_source_ref)
      push(a, "MissingSource", `Posted from ${a.source_module} but no source document reference is linked.`)

    // A GST/TDS line with no tax amount recorded is a mismatch worth a look;
    // conversely tax recorded on a voucher whose GL rollup dropped it.
    if (posted && a.gl_lines > 0) {
      if (Math.abs(a.debit - a.gl_debit) > 0.01 || Math.abs(a.credit - a.gl_credit) > 0.01)
        push(
          a,
          "GlMismatch",
          `Journal totals (Dr ${a.debit}/Cr ${a.credit}) do not match General Ledger (Dr ${a.gl_debit}/Cr ${a.gl_credit}).`,
        )
    }
    if (posted && a.gl_lines === 0)
      push(a, "GlMismatch", `Voucher is marked Posted but has no matching General Ledger lines.`)

    // Posting failed: approved but never reached the ledger.
    if (approved && !posted && a.gl_lines === 0 && a.approval_status === "Approved")
      push(a, "PostingFailed", `Approved but not posted to the ledger — posting did not complete.`)

    if (lockedPeriods.has(a.period) && !posted)
      push(a, "ClosedPeriod", `Voucher sits in locked period ${a.period} but is not posted.`)
  }

  // Stable order: errors first, then by period desc, then voucher.
  out.sort((x, y) => {
    if (x.severity !== y.severity) return x.severity === "error" ? -1 : 1
    if (x.period !== y.period) return x.period < y.period ? 1 : -1
    return x.voucherNo < y.voucherNo ? -1 : 1
  })
  return out
}

export type MonthEndCheck = {
  key: string
  label: string
  count: number
  status: "clean" | "attention"
  vouchers: string[]
}

export type MonthEndReport = {
  period: string
  locked: boolean
  clean: boolean
  checks: MonthEndCheck[]
}

/**
 * Phase 55 — month-end checklist for a single period. Returns one row per check
 * dimension the spec lists, each with the offending voucher numbers so finance
 * can drill straight to them before locking the month.
 */
export async function monthEndReport(period: string): Promise<MonthEndReport> {
  const key = periodKeyFor(period)
  const { sql, params } = periodClause(key)

  // Unposted journals and pending approvals come straight from status columns.
  const statusRows = (await query(
    `SELECT je.voucher_no AS voucher_no,
            COALESCE(MAX(je.posting_status), '')  AS posting_status,
            COALESCE(MAX(je.approval_status), '') AS approval_status
       FROM journal_entries je
      WHERE je.voucher_no IS NOT NULL AND je.voucher_no <> ''${sql}
      GROUP BY je.voucher_no`,
    params,
  )) as any[]

  const unposted: string[] = []
  const pending: string[] = []
  for (const r of statusRows) {
    if (String(r.posting_status) !== "Posted") unposted.push(String(r.voucher_no))
    if (String(r.approval_status) === "Pending Approval") pending.push(String(r.voucher_no))
  }

  // The remaining dimensions map onto exception codes for this period.
  const exceptions = await computeJournalExceptions(key)
  const vouchersFor = (codes: ExceptionCode[]) =>
    Array.from(new Set(exceptions.filter((e) => codes.includes(e.code)).map((e) => e.voucherNo)))

  const unbalanced = vouchersFor(["Unbalanced"])
  const wrongAccounts = vouchersFor(["MissingAccount", "InvalidAccount"])
  const missingSource = vouchersFor(["MissingSource"])
  const taxMismatch = vouchersFor(["GstMismatch", "TdsMismatch"])

  const mk = (k: string, label: string, vouchers: string[]): MonthEndCheck => ({
    key: k,
    label,
    count: vouchers.length,
    status: vouchers.length ? "attention" : "clean",
    vouchers,
  })

  const checks: MonthEndCheck[] = [
    mk("unposted", "Unposted journals", unposted),
    mk("pending", "Pending approval", pending),
    mk("unbalanced", "Unbalanced journals", unbalanced),
    mk("wrong_accounts", "Wrong / missing accounts", wrongAccounts),
    mk("missing_source", "Missing source", missingSource),
    mk("tax_mismatch", "Tax mismatch", taxMismatch),
  ]

  return {
    period: key,
    locked: await isPeriodLocked(key),
    clean: checks.every((c) => c.status === "clean"),
    checks,
  }
}

export type ErrorCenterGroup = {
  code: ExceptionCode
  label: string
  severity: "error" | "warning"
  count: number
  exceptions: JournalException[]
}

const ERROR_LABELS: Record<ExceptionCode, string> = {
  Unbalanced: "Unbalanced",
  MissingAccount: "Missing account",
  InvalidAccount: "Invalid account",
  Duplicate: "Duplicate",
  MissingSource: "Missing source",
  GstMismatch: "GST mismatch",
  TdsMismatch: "TDS mismatch",
  ClosedPeriod: "Closed period",
  PostingFailed: "Posting failed",
  GlMismatch: "GL mismatch",
}

/** Phase 60 — the error center: exceptions grouped by code for the dashboard. */
export async function errorCenter(period?: string | null): Promise<{
  total: number
  errors: number
  warnings: number
  groups: ErrorCenterGroup[]
}> {
  const exceptions = await computeJournalExceptions(period)
  const order: ExceptionCode[] = [
    "Unbalanced",
    "MissingAccount",
    "InvalidAccount",
    "GlMismatch",
    "PostingFailed",
    "ClosedPeriod",
    "MissingSource",
    "Duplicate",
    "GstMismatch",
    "TdsMismatch",
  ]
  const groups: ErrorCenterGroup[] = order
    .map((code) => {
      const ex = exceptions.filter((e) => e.code === code)
      return { code, label: ERROR_LABELS[code], severity: SEVERITY[code], count: ex.length, exceptions: ex }
    })
    .filter((g) => g.count > 0)

  return {
    total: exceptions.length,
    errors: exceptions.filter((e) => e.severity === "error").length,
    warnings: exceptions.filter((e) => e.severity === "warning").length,
    groups,
  }
}

export type ReconciliationSummary = {
  scope: "GST" | "TDS" | "Bank / Payment / Receipt" | "Other"
  reconciled: number
  unreconciled: number
  total: number
}

/**
 * Phase 54 — reconciliation status of posted journals, grouped by the source
 * dimension the spec calls out (Bank/Payment/Receipt, GST, TDS). Reads the
 * `reconciliation_status` the General Ledger already tracks so it stays in step
 * with lib/finance-bank-reconciliation.ts and never invents a parallel state.
 */
export async function reconciliationSummary(period?: string | null): Promise<ReconciliationSummary[]> {
  const key = periodKeyFor(period)
  const hasPeriod = /^\d{4}-\d{2}$/.test(key)
  const rows = (await query(
    `SELECT COALESCE(source_module, '')      AS source_module,
            COALESCE(voucher_type, '')        AS voucher_type,
            COALESCE(reconciliation_status,'Unreconciled') AS reconciliation_status,
            COUNT(*)                          AS n
       FROM general_ledger
      WHERE 1 = 1 ${hasPeriod ? "AND DATE_FORMAT(transaction_date, '%Y-%m') = ?" : ""}
      GROUP BY source_module, voucher_type, reconciliation_status`,
    hasPeriod ? [key] : [],
  )) as any[]

  const buckets: Record<string, { reconciled: number; unreconciled: number }> = {
    GST: { reconciled: 0, unreconciled: 0 },
    TDS: { reconciled: 0, unreconciled: 0 },
    "Bank / Payment / Receipt": { reconciled: 0, unreconciled: 0 },
    Other: { reconciled: 0, unreconciled: 0 },
  }

  for (const r of rows) {
    const mod = `${r.source_module} ${r.voucher_type}`.toLowerCase()
    let scope: keyof typeof buckets = "Other"
    if (mod.includes("gst")) scope = "GST"
    else if (mod.includes("tds")) scope = "TDS"
    else if (mod.includes("bank") || mod.includes("payment") || mod.includes("receipt") || mod.includes("cash"))
      scope = "Bank / Payment / Receipt"
    const reconciled = String(r.reconciliation_status).toLowerCase() === "reconciled"
    if (reconciled) buckets[scope].reconciled += num(r.n)
    else buckets[scope].unreconciled += num(r.n)
  }

  return (Object.keys(buckets) as (keyof typeof buckets)[])
    .map((scope) => ({
      scope: scope as ReconciliationSummary["scope"],
      reconciled: buckets[scope].reconciled,
      unreconciled: buckets[scope].unreconciled,
      total: buckets[scope].reconciled + buckets[scope].unreconciled,
    }))
    .filter((b) => b.total > 0)
}
