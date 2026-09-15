import "server-only"
import { query } from "@/lib/db"
import { listPeriodLocks } from "@/lib/finance-period-lock"

// ---------------------------------------------------------------------------
// General Ledger read model (Phases 11–20).
//
// The General Ledger is the CENTRAL LEDGER of posted accounting transactions.
// Every row is written by the server-side posting engine (manual & automated
// journals, sales/purchase/expense/bank/opening-balance postings) — never by
// hand — so this module is a pure, read-only analytical layer on top of the
// same `general_ledger` table the config-driven CRUD factory targets. Journal
// Entries stays the primary accounting source; this just reads what was posted.
//
// Everything here is derived live from posted rows: reversals post equal-and-
// opposite lines, so summing every matching row nets them out automatically.
//
// Net Movement — defined once and used everywhere:
//     Net Movement = Total Debit − Total Credit   (signed; side = Dr when ≥ 0)
// ---------------------------------------------------------------------------

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

export type Side = "Debit" | "Credit"

/** The canonical Net Movement helper — the single formula for the whole app. */
export function netMovement(totalDebit: number, totalCredit: number) {
  const net = round2(num(totalDebit) - num(totalCredit))
  return { net, side: (net >= 0 ? "Debit" : "Credit") as Side, magnitude: round2(Math.abs(net)) }
}

// ---------------------------------------------------------------------------
// Period resolution
// ---------------------------------------------------------------------------
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "2026-27" → the Apr 1 2026 … Mar 31 2027 calendar window. */
function fyRange(fy: string): { startYear: number; start: string; end: string } | null {
  const m = String(fy || "").match(/(\d{4})/)
  if (!m) return null
  const startYear = Number(m[1])
  return { startYear, start: `${startYear}-04-01`, end: `${startYear + 1}-03-31` }
}

/** Quarter → the three 1-based month numbers it contains (fiscal, Apr start). */
const FISCAL_QUARTER_MONTHS: Record<string, number[]> = {
  Q1: [4, 5, 6],
  Q2: [7, 8, 9],
  Q3: [10, 11, 12],
  Q4: [1, 2, 3],
}

export type GLFilters = {
  search?: string
  financial_year?: string
  month?: string // 1-12
  quarter?: string // Q1..Q4
  date_from?: string
  date_to?: string
  account_id?: string
  account_group?: string
  account_type?: string
  transaction_type?: string
  voucher_type?: string
  party?: string // party_name
  party_type?: string // Customer | Vendor | Employee | Freelancer (derived)
  project?: string // project_name
  source_module?: string
  reconciliation_status?: string
  side?: string // Debit | Credit
  balance_type?: string // Debit | Credit
}

/**
 * Resolve the reporting window's start/end dates. Explicit date range wins;
 * otherwise the financial year defines the base window, narrowed by quarter or
 * month when the FY is known. Returns nulls when nothing pins a concrete date
 * (opening balance then falls back to zero — see buildOpeningNet).
 */
function resolvePeriod(f: GLFilters): { start: string | null; end: string | null } {
  let start: string | null = null
  let end: string | null = null

  const range = f.financial_year ? fyRange(f.financial_year) : null
  if (range) {
    start = range.start
    end = range.end
    if (f.quarter && FISCAL_QUARTER_MONTHS[f.quarter]) {
      const months = FISCAL_QUARTER_MONTHS[f.quarter]
      // Q1-Q3 sit in the FY start year; Q4 (Jan-Mar) rolls into the next year.
      const y = f.quarter === "Q4" ? range.startYear + 1 : range.startYear
      const first = months[0]
      const last = months[months.length - 1]
      start = `${y}-${String(first).padStart(2, "0")}-01`
      end = `${y}-${String(last).padStart(2, "0")}-${last === 2 ? "28" : [4, 6, 9, 11].includes(last) ? "30" : "31"}`
    } else if (f.month) {
      const mm = Number(f.month)
      if (mm >= 1 && mm <= 12) {
        const y = mm >= 4 ? range.startYear : range.startYear + 1
        const lastDay = mm === 2 ? "29" : [4, 6, 9, 11].includes(mm) ? "30" : "31"
        start = `${y}-${String(mm).padStart(2, "0")}-01`
        end = `${y}-${String(mm).padStart(2, "0")}-${lastDay}`
      }
    }
  }
  if (f.date_from) start = f.date_from
  if (f.date_to) end = f.date_to
  return { start, end }
}

// ---------------------------------------------------------------------------
// WHERE builders. Dimension conditions (account/party/project/type/…) are kept
// separate from temporal ones so the OPENING balance can reuse the dimensions
// with a "before the period start" date cut.
// ---------------------------------------------------------------------------
function dimensionWhere(f: GLFilters): { conditions: string[]; args: any[] } {
  const conditions: string[] = []
  const args: any[] = []
  const eq = (col: string, val?: string) => {
    if (val) {
      conditions.push(`${col} = ?`)
      args.push(val)
    }
  }
  eq("account_id", f.account_id)
  eq("account_group", f.account_group)
  eq("account_type", f.account_type)
  eq("transaction_type", f.transaction_type)
  eq("voucher_type", f.voucher_type)
  eq("party_name", f.party)
  eq("project_name", f.project)
  eq("source_module", f.source_module)
  eq("balance_type", f.balance_type)
  if (f.reconciliation_status) {
    conditions.push(`COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') = ?`)
    args.push(f.reconciliation_status)
  }
  if (f.side === "Debit") conditions.push(`debit > 0`)
  if (f.side === "Credit") conditions.push(`credit > 0`)

  if (f.search) {
    const cols = [
      "ledger_id",
      "journal_entry_id",
      "voucher_no",
      "reference_no",
      "account_name",
      "party_name",
      "project_name",
      "source_reference",
      "cheque_utr_reference",
    ]
    conditions.push("(" + cols.map((c) => `${c} LIKE ?`).join(" OR ") + ")")
    const like = `%${f.search}%`
    cols.forEach(() => args.push(like))
  }
  return { conditions, args }
}

/** Temporal row conditions for the "within the period" set. */
function periodWhere(
  f: GLFilters,
  period: { start: string | null; end: string | null },
): { conditions: string[]; args: any[] } {
  const conditions: string[] = []
  const args: any[] = []
  if (period.start) {
    conditions.push(`transaction_date >= ?`)
    args.push(period.start)
  }
  if (period.end) {
    conditions.push(`transaction_date <= ?`)
    args.push(period.end)
  }
  // Month / quarter applied as row predicates only when no FY pinned them into
  // the date window above (avoids double-filtering).
  if (!f.financial_year) {
    if (f.month) {
      conditions.push(`MONTH(transaction_date) = ?`)
      args.push(Number(f.month))
    }
    if (f.quarter && FISCAL_QUARTER_MONTHS[f.quarter]) {
      const months = FISCAL_QUARTER_MONTHS[f.quarter]
      conditions.push(`MONTH(transaction_date) IN (${months.map(() => "?").join(",")})`)
      months.forEach((m) => args.push(m))
    }
  }
  return { conditions, args }
}

function whereClause(parts: string[]): string {
  return parts.length ? `WHERE ${parts.join(" AND ")}` : ""
}

async function safe<T = any>(sql: string, args: any[] = []): Promise<T[]> {
  try {
    return (await query(sql, args)) as T[]
  } catch (error) {
    console.log("[v0] general-ledger query failed:", (error as Error)?.message)
    return []
  }
}

/**
 * Opening net (Σ debit − Σ credit) for the dimension-filtered rows BEFORE the
 * period start. Zero when the period has no resolvable start date (e.g. an
 * all-time view or a bare month filter without a financial year).
 */
async function buildOpeningNet(f: GLFilters, period: { start: string | null }): Promise<number> {
  if (!period.start) return 0
  const dim = dimensionWhere(f)
  const conditions = [...dim.conditions, `transaction_date < ?`]
  const args = [...dim.args, period.start]
  const [row] = await safe(
    `SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM general_ledger ${whereClause(conditions)}`,
    args,
  )
  return round2(num(row?.d) - num(row?.c))
}

// ---------------------------------------------------------------------------
// Filter options (dropdowns) — distinct values straight from posted rows.
// ---------------------------------------------------------------------------
export type FilterOptions = {
  financialYears: string[]
  accounts: { id: string; name: string; group: string | null }[]
  accountGroups: string[]
  accountTypes: string[]
  transactionTypes: string[]
  voucherTypes: string[]
  parties: string[]
  projects: string[]
  sourceModules: string[]
  reconciliationStatuses: string[]
}

async function getFilterOptions(): Promise<FilterOptions> {
  const [
    fys,
    accounts,
    groups,
    types,
    txnTypes,
    voucherTypes,
    parties,
    projects,
    sources,
    recon,
  ] = await Promise.all([
    safe(`SELECT DISTINCT financial_year v FROM general_ledger WHERE financial_year<>'' ORDER BY v DESC`),
    safe(
      `SELECT account_id id, MAX(account_name) name, MAX(account_group) g
         FROM general_ledger WHERE account_id<>'' GROUP BY account_id ORDER BY name`,
    ),
    safe(`SELECT DISTINCT account_group v FROM general_ledger WHERE account_group<>'' ORDER BY v`),
    safe(`SELECT DISTINCT account_type v FROM general_ledger WHERE account_type<>'' ORDER BY v`),
    safe(`SELECT DISTINCT transaction_type v FROM general_ledger WHERE transaction_type<>'' ORDER BY v`),
    safe(`SELECT DISTINCT voucher_type v FROM general_ledger WHERE voucher_type<>'' ORDER BY v`),
    safe(`SELECT DISTINCT party_name v FROM general_ledger WHERE party_name<>'' ORDER BY v`),
    safe(`SELECT DISTINCT project_name v FROM general_ledger WHERE project_name<>'' ORDER BY v`),
    safe(`SELECT DISTINCT source_module v FROM general_ledger WHERE source_module<>'' ORDER BY v`),
    safe(
      `SELECT DISTINCT COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') v FROM general_ledger ORDER BY v`,
    ),
  ])
  return {
    financialYears: fys.map((r) => r.v),
    accounts: accounts.map((r) => ({ id: String(r.id), name: r.name, group: r.g ?? null })),
    accountGroups: groups.map((r) => r.v),
    accountTypes: types.map((r) => r.v),
    transactionTypes: txnTypes.map((r) => r.v),
    voucherTypes: voucherTypes.map((r) => r.v),
    parties: parties.map((r) => r.v),
    projects: projects.map((r) => r.v),
    sourceModules: sources.map((r) => r.v),
    reconciliationStatuses: recon.map((r) => r.v),
  }
}

// ---------------------------------------------------------------------------
// Dashboard cards (Phase 17 + 18) — computed under the active filters.
// ---------------------------------------------------------------------------
export type DashboardCards = {
  totalDebit: number
  totalCredit: number
  netMovement: number
  netSide: Side
  totalRows: number
  postedEntries: number
  unreconciled: number
  accountsUsed: number
  journalLinked: number
}

async function getCards(f: GLFilters, period: { start: string | null; end: string | null }): Promise<DashboardCards> {
  const dim = dimensionWhere(f)
  const per = periodWhere(f, period)
  const conditions = [...dim.conditions, ...per.conditions]
  const args = [...dim.args, ...per.args]
  const [row] = await safe(
    `SELECT
        COALESCE(SUM(debit),0) totalDebit,
        COALESCE(SUM(credit),0) totalCredit,
        COUNT(*) totalRows,
        COUNT(DISTINCT NULLIF(voucher_no,'')) postedEntries,
        SUM(CASE WHEN COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') <> 'Reconciled' THEN 1 ELSE 0 END) unreconciled,
        COUNT(DISTINCT NULLIF(account_id,'')) accountsUsed,
        SUM(CASE WHEN journal_entry_id IS NOT NULL AND journal_entry_id <> '' THEN 1 ELSE 0 END) journalLinked
      FROM general_ledger ${whereClause(conditions)}`,
    args,
  )
  const totalDebit = round2(num(row?.totalDebit))
  const totalCredit = round2(num(row?.totalCredit))
  const nm = netMovement(totalDebit, totalCredit)
  return {
    totalDebit,
    totalCredit,
    netMovement: nm.net,
    netSide: nm.side,
    totalRows: num(row?.totalRows),
    postedEntries: num(row?.postedEntries),
    unreconciled: num(row?.unreconciled),
    accountsUsed: num(row?.accountsUsed),
    journalLinked: num(row?.journalLinked),
  }
}

// ---------------------------------------------------------------------------
// Ledger view — filtered rows + opening / debit / credit / closing summary.
// ---------------------------------------------------------------------------
export type PeriodSummary = {
  opening: number
  openingSide: Side
  debit: number
  credit: number
  closing: number
  closingSide: Side
  net: number
  netSide: Side
}

function summaryFromTotals(opening: number, debit: number, credit: number): PeriodSummary {
  const nm = netMovement(debit, credit)
  const closingNet = round2(opening + (debit - credit))
  return {
    opening: round2(Math.abs(opening)),
    openingSide: opening >= 0 ? "Debit" : "Credit",
    debit: round2(debit),
    credit: round2(credit),
    closing: round2(Math.abs(closingNet)),
    closingSide: closingNet >= 0 ? "Debit" : "Credit",
    net: nm.magnitude,
    netSide: nm.side,
  }
}

async function getLedgerView(f: GLFilters, period: { start: string | null; end: string | null }, limit: number) {
  const dim = dimensionWhere(f)
  const per = periodWhere(f, period)
  const conditions = [...dim.conditions, ...per.conditions]
  const args = [...dim.args, ...per.args]

  const rows = await safe(
    `SELECT id, ledger_id, journal_entry_id, voucher_no, voucher_type, transaction_type,
            financial_year, transaction_date, value_date, month,
            account_id, account_name, account_group, account_type,
            party_id, party_name, project_id, project_name, description,
            debit, credit, amount, gst_amount, tds_amount, balance, balance_type,
            payment_mode, cheque_utr_reference, source_module, source_reference,
            reference_no, reconciliation_status, reconciliation_date, attachment_link
       FROM general_ledger
       ${whereClause(conditions)}
       ORDER BY transaction_date DESC, id DESC
       LIMIT ${Math.max(1, Math.min(limit, 2000))}`,
    args,
  )

  const [totals] = await safe(
    `SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM general_ledger ${whereClause(conditions)}`,
    args,
  )
  const opening = await buildOpeningNet(f, period)
  const summary = summaryFromTotals(opening, round2(num(totals?.d)), round2(num(totals?.c)))
  return { rows, summary, count: rows.length }
}

// ---------------------------------------------------------------------------
// Party ledger (Phase 12) — opening / debit / credit / closing per party, with
// a best-effort party type derived from the postings that touch it.
// ---------------------------------------------------------------------------
function classifyParty(blob: string): string {
  const s = blob.toLowerCase()
  if (s.includes("freelance")) return "Freelancer"
  if (s.includes("fte") || s.includes("payroll") || s.includes("salary")) return "Employee"
  if (s.includes("sales") || s.includes("receipt") || s.includes("invoice")) return "Customer"
  if (s.includes("purchase") || s.includes("expense") || s.includes("bill")) return "Vendor"
  return "Other"
}

export type PartyLedgerRow = {
  party: string
  partyType: string
  opening: number
  openingSide: Side
  debit: number
  credit: number
  closing: number
  closingSide: Side
}

async function getPartyLedger(f: GLFilters, period: { start: string | null; end: string | null }) {
  const dim = dimensionWhere(f)
  const per = periodWhere(f, period)
  const withinArgs = [...dim.args, ...per.args]
  const withinWhere = whereClause([`party_name <> ''`, ...dim.conditions, ...per.conditions])

  const within = await safe(
    `SELECT party_name party,
            COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c,
            GROUP_CONCAT(DISTINCT source_module SEPARATOR ' ') sources,
            GROUP_CONCAT(DISTINCT voucher_type SEPARATOR ' ') vouchers
       FROM general_ledger ${withinWhere}
       GROUP BY party_name
       ORDER BY party_name`,
    withinArgs,
  )

  // Opening per party (before the period start), keyed for a quick lookup.
  const openingMap = new Map<string, number>()
  if (period.start) {
    const openWhere = whereClause([`party_name <> ''`, ...dim.conditions, `transaction_date < ?`])
    const openArgs = [...dim.args, period.start]
    const opens = await safe(
      `SELECT party_name party, COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) net
         FROM general_ledger ${openWhere} GROUP BY party_name`,
      openArgs,
    )
    for (const r of opens) openingMap.set(String(r.party), round2(num(r.net)))
  }

  let rows: PartyLedgerRow[] = within.map((r) => {
    const opening = openingMap.get(String(r.party)) ?? 0
    const debit = round2(num(r.d))
    const credit = round2(num(r.c))
    const closingNet = round2(opening + (debit - credit))
    return {
      party: String(r.party),
      partyType: classifyParty(`${r.sources ?? ""} ${r.vouchers ?? ""}`),
      opening: round2(Math.abs(opening)),
      openingSide: opening >= 0 ? "Debit" : "Credit",
      debit,
      credit,
      closing: round2(Math.abs(closingNet)),
      closingSide: closingNet >= 0 ? "Debit" : "Credit",
    }
  })
  if (f.party_type) rows = rows.filter((r) => r.partyType === f.party_type)
  return { rows }
}

// ---------------------------------------------------------------------------
// Project ledger (Phase 13) — opening / debit / credit / closing per project.
// ---------------------------------------------------------------------------
export type ProjectLedgerRow = {
  project: string
  opening: number
  openingSide: Side
  debit: number
  credit: number
  closing: number
  closingSide: Side
}

async function getProjectLedger(f: GLFilters, period: { start: string | null; end: string | null }) {
  const dim = dimensionWhere(f)
  const per = periodWhere(f, period)
  const within = await safe(
    `SELECT project_name project, COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c
       FROM general_ledger ${whereClause([`project_name <> ''`, ...dim.conditions, ...per.conditions])}
       GROUP BY project_name ORDER BY project_name`,
    [...dim.args, ...per.args],
  )
  const openingMap = new Map<string, number>()
  if (period.start) {
    const opens = await safe(
      `SELECT project_name project, COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) net
         FROM general_ledger ${whereClause([`project_name <> ''`, ...dim.conditions, `transaction_date < ?`])}
         GROUP BY project_name`,
      [...dim.args, period.start],
    )
    for (const r of opens) openingMap.set(String(r.project), round2(num(r.net)))
  }
  const rows: ProjectLedgerRow[] = within.map((r) => {
    const opening = openingMap.get(String(r.project)) ?? 0
    const debit = round2(num(r.d))
    const credit = round2(num(r.c))
    const closingNet = round2(opening + (debit - credit))
    return {
      project: String(r.project),
      opening: round2(Math.abs(opening)),
      openingSide: opening >= 0 ? "Debit" : "Credit",
      debit,
      credit,
      closing: round2(Math.abs(closingNet)),
      closingSide: closingNet >= 0 ? "Debit" : "Credit",
    }
  })
  return { rows }
}

// ---------------------------------------------------------------------------
// Monthly ledger (Phase 14) — per calendar month opening / debit / credit /
// closing, with the closing of each month carried into the next as its opening.
// ---------------------------------------------------------------------------
export type MonthlyLedgerRow = {
  label: string
  year: number
  month: number
  opening: number
  openingSide: Side
  debit: number
  credit: number
  closing: number
  closingSide: Side
}

async function getMonthlyLedger(f: GLFilters, period: { start: string | null; end: string | null }) {
  const dim = dimensionWhere(f)
  const per = periodWhere(f, period)
  const grouped = await safe(
    `SELECT YEAR(transaction_date) y, MONTH(transaction_date) m,
            COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c
       FROM general_ledger ${whereClause([`transaction_date IS NOT NULL`, ...dim.conditions, ...per.conditions])}
       GROUP BY YEAR(transaction_date), MONTH(transaction_date)
       ORDER BY y ASC, m ASC`,
    [...dim.args, ...per.args],
  )
  let running = await buildOpeningNet(f, period)
  const rows: MonthlyLedgerRow[] = grouped.map((r) => {
    const y = num(r.y)
    const m = num(r.m)
    const debit = round2(num(r.d))
    const credit = round2(num(r.c))
    const opening = running
    const closingNet = round2(opening + (debit - credit))
    running = closingNet
    return {
      label: `${MONTH_SHORT[m - 1] ?? m} ${y}`,
      year: y,
      month: m,
      opening: round2(Math.abs(opening)),
      openingSide: opening >= 0 ? "Debit" : "Credit",
      debit,
      credit,
      closing: round2(Math.abs(closingNet)),
      closingSide: closingNet >= 0 ? "Debit" : "Credit",
    }
  })
  return { rows }
}

// ---------------------------------------------------------------------------
// Reconciliation view (Phase 19) — connect GL rows to their Journal / Source
// links and derive a reconciliation status per row.
//
//   Reconciled   — stored status already Reconciled.
//   Matched      — linked to a Journal voucher or a source document.
//   Mismatch     — a debit/credit-only row whose voucher does not balance.
//   Needs Review — posted but with no journal / source linkage.
//   Unreconciled — everything else awaiting reconciliation.
// ---------------------------------------------------------------------------
export const RECON_STATUSES = ["Unreconciled", "Matched", "Reconciled", "Mismatch", "Needs Review"] as const
export type ReconStatus = (typeof RECON_STATUSES)[number]

function deriveReconStatus(row: any, unbalancedVouchers: Set<string>): ReconStatus {
  const stored = String(row.reconciliation_status || "Unreconciled")
  if (stored === "Reconciled") return "Reconciled"
  const voucher = String(row.voucher_no || "")
  if (voucher && unbalancedVouchers.has(voucher)) return "Mismatch"
  const hasJournal = !!String(row.journal_entry_id || "").trim()
  const hasSource = !!String(row.source_reference || "").trim() || !!String(row.source_module || "").trim()
  if (hasJournal || hasSource) return "Matched"
  return "Needs Review"
}

async function getReconciliationView(
  f: GLFilters,
  period: { start: string | null; end: string | null },
  limit: number,
) {
  const dim = dimensionWhere(f)
  const per = periodWhere(f, period)
  const conditions = [...dim.conditions, ...per.conditions]
  const args = [...dim.args, ...per.args]

  const rows = await safe(
    `SELECT id, ledger_id, journal_entry_id, voucher_no, transaction_date,
            account_name, party_name, debit, credit, source_module, source_reference,
            cheque_utr_reference, reference_no, reconciliation_status, reconciliation_date
       FROM general_ledger ${whereClause(conditions)}
       ORDER BY transaction_date DESC, id DESC
       LIMIT ${Math.max(1, Math.min(limit, 2000))}`,
    args,
  )

  // A voucher whose posted legs do not net to zero is a Mismatch. Computed over
  // the whole ledger (not just the filtered slice) so a partial filter can't
  // make a balanced voucher look unbalanced.
  const unbalanced = await safe(
    `SELECT voucher_no FROM general_ledger
      WHERE voucher_no IS NOT NULL AND voucher_no <> ''
      GROUP BY voucher_no
      HAVING ABS(COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0)) > 0.01`,
  )
  const unbalancedVouchers = new Set(unbalanced.map((r) => String(r.voucher_no)))

  const counts: Record<ReconStatus, number> = {
    Unreconciled: 0,
    Matched: 0,
    Reconciled: 0,
    Mismatch: 0,
    "Needs Review": 0,
  }
  const decorated = rows.map((r) => {
    const status = deriveReconStatus(r, unbalancedVouchers)
    counts[status] += 1
    return { ...r, recon_status: status }
  })
  return { rows: decorated, counts }
}

// ---------------------------------------------------------------------------
// Bank reconciliation (Phase 20) — compare bank-related GL entries against the
// Bank Transactions ledger on Amount / Date / Reference / UTR / Account /
// Source, so mismatches are visible.
// ---------------------------------------------------------------------------
const normRef = (v: any) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, "")

function daysGap(a?: string | null, b?: string | null): number | null {
  if (!a || !b) return null
  const da = new Date(a).getTime()
  const db = new Date(b).getTime()
  if (Number.isNaN(da) || Number.isNaN(db)) return null
  return Math.abs(Math.round((da - db) / 86_400_000))
}

export type BankReconRow = {
  transactionId: string
  date: string | null
  account: string | null
  party: string | null
  reference: string | null
  utr: string | null
  amount: number
  side: Side
  sourceModule: string | null
  reconciliation_status: string
  status: ReconStatus
  matched: {
    ledgerId: string
    date: string | null
    account: string | null
    amount: number
    reference: string | null
    utr: string | null
  } | null
  fields: { amount: boolean; date: boolean; reference: boolean; utr: boolean; account: boolean; source: boolean }
}

async function getBankReconciliation(f: GLFilters, period: { start: string | null; end: string | null }) {
  // Bank transactions in the reporting window (reuse date range only; the other
  // GL dimensions don't map onto the bank ledger).
  const conditions: string[] = []
  const args: any[] = []
  if (period.start) {
    conditions.push(`transaction_date >= ?`)
    args.push(period.start)
  }
  if (period.end) {
    conditions.push(`transaction_date <= ?`)
    args.push(period.end)
  }
  if (f.financial_year) {
    conditions.push(`financial_year = ?`)
    args.push(f.financial_year)
  }
  if (f.search) {
    const cols = ["transaction_id", "reference_no", "cheque_utr_reference", "party_name", "account_name"]
    conditions.push("(" + cols.map((c) => `${c} LIKE ?`).join(" OR ") + ")")
    const like = `%${f.search}%`
    cols.forEach(() => args.push(like))
  }

  const bankTxns = await safe(
    `SELECT transaction_id, transaction_date, account_name, party_name, reference_no,
            cheque_utr_reference, debit, credit, source_module, reconciliation_status
       FROM bank_transactions ${whereClause(conditions)}
       ORDER BY transaction_date DESC, id DESC
       LIMIT 500`,
    args,
  )

  // Candidate bank-related GL rows (posted from Bank & Cash, or carrying a
  // cheque/UTR reference). Pulled once and matched in memory.
  const glRows = await safe(
    `SELECT ledger_id, transaction_date, account_name, account_id, debit, credit,
            reference_no, cheque_utr_reference, source_module, source_reference, party_name
       FROM general_ledger
      WHERE (source_module LIKE '%Bank%' OR source_module LIKE '%Cash%'
             OR cheque_utr_reference <> '' OR payment_mode <> '')
      ORDER BY transaction_date DESC
      LIMIT 2000`,
  )

  const counts: Record<ReconStatus, number> = {
    Unreconciled: 0,
    Matched: 0,
    Reconciled: 0,
    Mismatch: 0,
    "Needs Review": 0,
  }

  const rows: BankReconRow[] = bankTxns.map((t) => {
    const amount = round2(Math.max(num(t.debit), num(t.credit)))
    const side: Side = num(t.debit) >= num(t.credit) ? "Debit" : "Credit"
    const utr = normRef(t.cheque_utr_reference)
    const ref = normRef(t.reference_no)
    const txnDate = t.transaction_date ? String(t.transaction_date).slice(0, 10) : null

    // Best candidate: closest amount, then reference/UTR, then date.
    let best: any = null
    let bestScore = -1
    for (const g of glRows) {
      const gAmount = round2(Math.max(num(g.debit), num(g.credit)))
      if (Math.abs(gAmount - amount) > 1) continue
      const gUtr = normRef(g.cheque_utr_reference)
      const gRef = normRef(g.reference_no) || normRef(g.source_reference)
      let score = 0
      if (Math.abs(gAmount - amount) <= 0.5) score += 40
      if (utr && (gUtr === utr || gRef === utr)) score += 30
      if (ref && (gRef === ref || gUtr === ref)) score += 15
      const gap = daysGap(txnDate, g.transaction_date ? String(g.transaction_date).slice(0, 10) : null)
      if (gap != null && gap <= 2) score += 10
      if (score > bestScore) {
        bestScore = score
        best = g
      }
    }

    const stored = String(t.reconciliation_status || "")
    let matchFields = { amount: false, date: false, reference: false, utr: false, account: false, source: false }
    let matched: BankReconRow["matched"] = null
    if (best) {
      const gAmount = round2(Math.max(num(best.debit), num(best.credit)))
      const gUtr = normRef(best.cheque_utr_reference)
      const gRef = normRef(best.reference_no) || normRef(best.source_reference)
      const gap = daysGap(txnDate, best.transaction_date ? String(best.transaction_date).slice(0, 10) : null)
      matchFields = {
        amount: Math.abs(gAmount - amount) <= 0.5,
        date: gap != null && gap <= 2,
        reference: !!ref && (gRef === ref || gUtr === ref),
        utr: !!utr && (gUtr === utr || gRef === utr),
        account: normRef(best.account_name) === normRef(t.account_name),
        source: !!String(best.source_module || "").trim(),
      }
      matched = {
        ledgerId: String(best.ledger_id),
        date: best.transaction_date ? String(best.transaction_date).slice(0, 10) : null,
        account: best.account_name ?? null,
        amount: gAmount,
        reference: best.reference_no ?? null,
        utr: best.cheque_utr_reference ?? null,
      }
    }

    let status: ReconStatus
    if (stored === "Reconciled") status = "Reconciled"
    else if (!best) status = "Unreconciled"
    else if (matchFields.amount && (matchFields.utr || matchFields.reference)) status = "Matched"
    else if (matchFields.amount) status = "Needs Review"
    else status = "Mismatch"
    counts[status] += 1

    return {
      transactionId: String(t.transaction_id),
      date: txnDate,
      account: t.account_name ?? null,
      party: t.party_name ?? null,
      reference: t.reference_no ?? null,
      utr: t.cheque_utr_reference ?? null,
      amount,
      side,
      sourceModule: t.source_module ?? null,
      reconciliation_status: stored || "Pending",
      status,
      matched,
      fields: matchFields,
    }
  })

  return { rows, counts }
}

// ---------------------------------------------------------------------------
// Integrity view (Phases 21 & 22) — GL ⇄ Journal ⇄ Source reconciliation.
//
// Journal Entries stays the PRIMARY accounting source; the General Ledger is the
// central record of what was posted. This view proves the two agree, voucher by
// voucher, and that both trace back to the originating source document:
//
//   Phase 21 (Journal reconciliation): a posted voucher's General Ledger
//   debit/credit total must equal the Journal Entries total that produced it,
//   and each side must itself balance. Any divergence is a GL Exception.
//
//   Phase 22 (Source reconciliation): the source document's amount must flow
//   Source → Journal → General Ledger with the same accounting effect (the
//   voucher's ledger debit total, which by construction equals the document's
//   gross/total). A divergence is a GL Exception.
//
// GST/TDS are compared as stored — never recomputed — so tax values recorded by
// the source engines are preserved, only totals are reconciled. This layer is
// strictly read-only: it inspects what the posting engine already wrote and
// mutates nothing. Balanced vouchers pass; only mismatches raise exceptions.
// ---------------------------------------------------------------------------

/** Source document tables whose stored gross/total maps onto a voucher's ledger
 *  debit total. Each posting engine writes debit-total = document gross by
 *  construction, so an equality check reconciles the source amount end-to-end. */
const SOURCE_AMOUNT_SPECS: { type: string; table: string; column: string; label: string }[] = [
  { type: "sales_invoice", table: "sales_invoices", column: "invoice_total", label: "Sales Invoice" },
  { type: "purchase_bill", table: "purchase_bills", column: "gross_bill_amount", label: "Purchase Bill" },
  { type: "expense", table: "expenses", column: "gross_amount", label: "Expense" },
]

export type GlIntegrityRow = {
  voucherNo: string
  date: string | null
  sourceModule: string
  sourceReference: string | null
  sourceType: string | null
  journalDebit: number
  journalCredit: number
  ledgerDebit: number
  ledgerCredit: number
  gst: number
  tds: number
  sourceAmount: number | null
  status: "Balanced" | "Exception"
  issues: string[]
}

export type GlIntegrityCounts = {
  total: number
  balanced: number
  exceptions: number
  journalMismatch: number
  sourceMismatch: number
  unbalanced: number
  missingJournal: number
}

/**
 * Reconcile every posted voucher in the reporting window. Only whole-voucher
 * safe filters (period / financial year / source module / free text) are
 * applied — account or party filters would slice a voucher and make a balanced
 * posting look unbalanced, so they are intentionally ignored here.
 */
async function getIntegrityView(f: GLFilters, period: { start: string | null; end: string | null }, limit: number) {
  const conditions: string[] = [`voucher_no <> ''`]
  const args: any[] = []
  if (period.start) {
    conditions.push(`transaction_date >= ?`)
    args.push(period.start)
  }
  if (period.end) {
    conditions.push(`transaction_date <= ?`)
    args.push(period.end)
  }
  if (f.financial_year) {
    conditions.push(`financial_year = ?`)
    args.push(f.financial_year)
  }
  if (f.source_module) {
    conditions.push(`source_module = ?`)
    args.push(f.source_module)
  }
  if (f.search) {
    const cols = ["voucher_no", "journal_entry_id", "source_reference", "reference_no", "party_name", "account_name"]
    conditions.push("(" + cols.map((c) => `${c} LIKE ?`).join(" OR ") + ")")
    const like = `%${f.search}%`
    cols.forEach(() => args.push(like))
  }

  const emptyCounts: GlIntegrityCounts = {
    total: 0, balanced: 0, exceptions: 0, journalMismatch: 0, sourceMismatch: 0, unbalanced: 0, missingJournal: 0,
  }

  const glRows = await safe(
    `SELECT voucher_no,
            MIN(transaction_date) transaction_date,
            COALESCE(MAX(source_module),'') source_module,
            COALESCE(MAX(source_reference),'') source_reference,
            COALESCE(MAX(source_entity_type),'') source_entity_type,
            MAX(source_entity_id) source_entity_id,
            ROUND(COALESCE(SUM(debit),0),2) gd,
            ROUND(COALESCE(SUM(credit),0),2) gc,
            ROUND(COALESCE(SUM(gst_amount),0),2) gst,
            ROUND(COALESCE(SUM(tds_amount),0),2) tds
       FROM general_ledger ${whereClause(conditions)}
       GROUP BY voucher_no
       ORDER BY MIN(transaction_date) DESC`,
    args,
  )
  if (!glRows.length) return { rows: [] as GlIntegrityRow[], counts: emptyCounts }

  const vouchers = glRows.map((r) => String(r.voucher_no))
  const ph = vouchers.map(() => "?").join(",")

  // Journal totals for the same vouchers (posted lines are what feed the GL).
  const jRows = await safe(
    `SELECT voucher_no,
            ROUND(COALESCE(SUM(debit),0),2) jd,
            ROUND(COALESCE(SUM(credit),0),2) jc,
            COUNT(*) lines
       FROM journal_entries
      WHERE voucher_no IN (${ph}) AND COALESCE(posting_status,'') = 'Posted'
      GROUP BY voucher_no`,
    vouchers,
  )
  const jMap = new Map(jRows.map((r) => [String(r.voucher_no), r]))

  // Source-document amounts, one grouped read per known source type.
  const sourceMap = new Map<string, number>()
  const byType = new Map<string, Set<string>>()
  for (const r of glRows) {
    const t = String(r.source_entity_type || "")
    const id = r.source_entity_id
    if (t && id != null && SOURCE_AMOUNT_SPECS.some((s) => s.type === t)) {
      if (!byType.has(t)) byType.set(t, new Set())
      byType.get(t)!.add(String(id))
    }
  }
  for (const [type, ids] of byType) {
    const spec = SOURCE_AMOUNT_SPECS.find((s) => s.type === type)!
    const idList = Array.from(ids)
    const iph = idList.map(() => "?").join(",")
    const rows = await safe(
      `SELECT id, COALESCE(${spec.column},0) amount FROM ${spec.table} WHERE id IN (${iph})`,
      idList,
    )
    for (const r of rows) sourceMap.set(`${type}:${r.id}`, round2(num(r.amount)))
  }

  const counts: GlIntegrityCounts = { ...emptyCounts }
  const rows: GlIntegrityRow[] = glRows.map((r) => {
    const voucherNo = String(r.voucher_no)
    const gd = round2(num(r.gd))
    const gc = round2(num(r.gc))
    const j = jMap.get(voucherNo)
    const jd = j ? round2(num(j.jd)) : 0
    const jc = j ? round2(num(j.jc)) : 0
    const type = String(r.source_entity_type || "") || null
    const sid = r.source_entity_id
    const sourceAmount = type && sid != null ? sourceMap.get(`${type}:${sid}`) ?? null : null
    const issues: string[] = []

    // Phase 21 — ledger internal balance + Journal ⇄ GL agreement.
    if (Math.abs(gd - gc) > 0.01) {
      issues.push(`Ledger voucher is not balanced (Dr ${gd.toFixed(2)} ≠ Cr ${gc.toFixed(2)}).`)
      counts.unbalanced += 1
    }
    if (!j) {
      issues.push(`No posted Journal Entries voucher backs this ledger posting.`)
      counts.missingJournal += 1
    } else {
      if (Math.abs(jd - jc) > 0.01) {
        issues.push(`Journal is not balanced (Dr ${jd.toFixed(2)} ≠ Cr ${jc.toFixed(2)}).`)
      }
      if (Math.abs(jd - gd) > 0.01 || Math.abs(jc - gc) > 0.01) {
        issues.push(
          `Journal total (Dr ${jd.toFixed(2)}/Cr ${jc.toFixed(2)}) does not match General Ledger (Dr ${gd.toFixed(2)}/Cr ${gc.toFixed(2)}).`,
        )
        counts.journalMismatch += 1
      }
    }
    // Phase 22 — source-document amount flows through to the ledger effect.
    if (sourceAmount != null && Math.abs(sourceAmount - gd) > 0.01) {
      const label = SOURCE_AMOUNT_SPECS.find((s) => s.type === type)?.label || "Source"
      issues.push(`${label} amount ${sourceAmount.toFixed(2)} does not match the posted ledger effect ${gd.toFixed(2)}.`)
      counts.sourceMismatch += 1
    }

    const status: "Balanced" | "Exception" = issues.length ? "Exception" : "Balanced"
    if (status === "Exception") counts.exceptions += 1
    else counts.balanced += 1
    counts.total += 1

    return {
      voucherNo,
      date: r.transaction_date ? String(r.transaction_date).slice(0, 10) : null,
      sourceModule: String(r.source_module || ""),
      sourceReference: String(r.source_reference || "") || null,
      sourceType: type,
      journalDebit: jd,
      journalCredit: jc,
      ledgerDebit: gd,
      ledgerCredit: gc,
      gst: round2(num(r.gst)),
      tds: round2(num(r.tds)),
      sourceAmount,
      status,
      issues,
    }
  })

  // Exceptions first, then most recent — so problems lead the table.
  rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === "Exception" ? -1 : 1
    return String(b.date ?? "").localeCompare(String(a.date ?? ""))
  })
  const capped = rows.slice(0, Math.max(1, Math.min(limit, 2000)))
  return { rows: capped, counts }
}

// ---------------------------------------------------------------------------
// Account ledger (Phase 48) — per-account Opening / Debit / Credit / Closing
// with a transaction count, straight from posted rows. The natural balance
// side follows the signed net (Dr when ≥ 0), matching the party/project views.
// ---------------------------------------------------------------------------
export type AccountLedgerRow = {
  accountId: string
  accountName: string
  accountGroup: string
  accountType: string
  opening: number
  openingSide: Side
  debit: number
  credit: number
  closing: number
  closingSide: Side
  txnCount: number
}

async function getAccountLedger(f: GLFilters, period: { start: string | null; end: string | null }) {
  const dim = dimensionWhere(f)
  const per = periodWhere(f, period)
  const within = await safe(
    `SELECT account_id,
            MIN(account_name) account_name,
            MIN(account_group) account_group,
            MIN(account_type) account_type,
            COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c,
            COUNT(*) txns
       FROM general_ledger ${whereClause([`account_id IS NOT NULL`, `account_id <> ''`, ...dim.conditions, ...per.conditions])}
       GROUP BY account_id
       ORDER BY MIN(account_group), MIN(account_name)`,
    [...dim.args, ...per.args],
  )

  const openingMap = new Map<string, number>()
  if (period.start) {
    const opens = await safe(
      `SELECT account_id, COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) net
         FROM general_ledger ${whereClause([`account_id IS NOT NULL`, `account_id <> ''`, ...dim.conditions, `transaction_date < ?`])}
         GROUP BY account_id`,
      [...dim.args, period.start],
    )
    for (const r of opens) openingMap.set(String(r.account_id), round2(num(r.net)))
  }

  let totalDebit = 0
  let totalCredit = 0
  const rows: AccountLedgerRow[] = within.map((r) => {
    const opening = openingMap.get(String(r.account_id)) ?? 0
    const debit = round2(num(r.d))
    const credit = round2(num(r.c))
    totalDebit = round2(totalDebit + debit)
    totalCredit = round2(totalCredit + credit)
    const closingNet = round2(opening + (debit - credit))
    return {
      accountId: String(r.account_id),
      accountName: String(r.account_name || ""),
      accountGroup: String(r.account_group || ""),
      accountType: String(r.account_type || ""),
      opening: round2(Math.abs(opening)),
      openingSide: opening >= 0 ? "Debit" : "Credit",
      debit,
      credit,
      closing: round2(Math.abs(closingNet)),
      closingSide: closingNet >= 0 ? "Debit" : "Credit",
      txnCount: Number(r.txns) || 0,
    }
  })

  const opening = await buildOpeningNet(f, period)
  const summary = summaryFromTotals(opening, totalDebit, totalCredit)
  return { rows, summary, count: rows.length }
}

// ---------------------------------------------------------------------------
// Exception Center (Phase 51) — one place that surfaces every way a posted
// ledger row can disagree with its source of truth. It is a strict superset of
// the integrity view: it reuses those voucher-level checks (unbalanced, missing
// journal, Journal ⇄ GL mismatch, source mismatch) and adds the remaining
// taxonomy the ledger can violate. Whole-voucher-safe filters only (period /
// FY / source / text) so a partial account/party slice can't fake an exception.
// ---------------------------------------------------------------------------
export type ExceptionCategory =
  | "unbalanced"
  | "missingJournal"
  | "journalMismatch"
  | "journalWithoutGl"
  | "duplicateGl"
  | "accountMissing"
  | "invalidAccount"
  | "sourceMismatch"
  | "gstMismatch"
  | "tdsMismatch"
  | "bankMismatch"
  | "periodLock"
  | "unreconciled"

export type ExceptionRow = {
  category: ExceptionCategory
  label: string
  severity: "high" | "medium" | "low"
  voucherNo: string | null
  ledgerId: string | null
  journalEntryId: string | null
  date: string | null
  account: string | null
  party: string | null
  detail: string
}

const EXCEPTION_META: Record<ExceptionCategory, { label: string; severity: "high" | "medium" | "low" }> = {
  unbalanced: { label: "Debit/Credit Mismatch", severity: "high" },
  missingJournal: { label: "GL Without Journal", severity: "high" },
  journalWithoutGl: { label: "Journal Without GL", severity: "high" },
  journalMismatch: { label: "Journal ⇄ GL Mismatch", severity: "high" },
  duplicateGl: { label: "Duplicate GL Posting", severity: "high" },
  accountMissing: { label: "Account Missing", severity: "high" },
  invalidAccount: { label: "Invalid Account", severity: "high" },
  sourceMismatch: { label: "Source Mismatch", severity: "medium" },
  gstMismatch: { label: "GST Mismatch", severity: "medium" },
  tdsMismatch: { label: "TDS Mismatch", severity: "medium" },
  bankMismatch: { label: "Bank Mismatch", severity: "medium" },
  periodLock: { label: "Period Lock Issue", severity: "medium" },
  unreconciled: { label: "Unreconciled", severity: "low" },
}

/** Whole-voucher-safe scope shared by the exception queries. */
function exceptionScope(f: GLFilters, period: { start: string | null; end: string | null }, alias = "") {
  const p = alias ? `${alias}.` : ""
  const conditions: string[] = [`${p}voucher_no IS NOT NULL`, `${p}voucher_no <> ''`]
  const args: any[] = []
  if (period.start) {
    conditions.push(`${p}transaction_date >= ?`)
    args.push(period.start)
  }
  if (period.end) {
    conditions.push(`${p}transaction_date <= ?`)
    args.push(period.end)
  }
  if (f.financial_year) {
    conditions.push(`${p}financial_year = ?`)
    args.push(f.financial_year)
  }
  if (f.source_module) {
    conditions.push(`${p}source_module = ?`)
    args.push(f.source_module)
  }
  if (f.search) {
    const cols = ["voucher_no", "journal_entry_id", "source_reference", "reference_no", "party_name", "account_name"]
    conditions.push("(" + cols.map((c) => `${p}${c} LIKE ?`).join(" OR ") + ")")
    const like = `%${f.search}%`
    cols.forEach(() => args.push(like))
  }
  return { conditions, args }
}

/** Same whole-voucher-safe scope, but for the journal_entries table (which has
 * no `journal_entry_id` column — its own `id` is the journal id). */
function journalScope(f: GLFilters, period: { start: string | null; end: string | null }, alias: string) {
  const p = `${alias}.`
  const conditions: string[] = [`${p}voucher_no IS NOT NULL`, `${p}voucher_no <> ''`]
  const args: any[] = []
  if (period.start) {
    conditions.push(`${p}transaction_date >= ?`)
    args.push(period.start)
  }
  if (period.end) {
    conditions.push(`${p}transaction_date <= ?`)
    args.push(period.end)
  }
  if (f.financial_year) {
    conditions.push(`${p}financial_year = ?`)
    args.push(f.financial_year)
  }
  if (f.source_module) {
    conditions.push(`${p}source_module = ?`)
    args.push(f.source_module)
  }
  if (f.search) {
    const cols = ["voucher_no", "source_reference", "reference_no", "party_name", "account_name"]
    conditions.push("(" + cols.map((c) => `${p}${c} LIKE ?`).join(" OR ") + ")")
    const like = `%${f.search}%`
    cols.forEach(() => args.push(like))
  }
  return { conditions, args }
}

async function getExceptionsView(
  f: GLFilters,
  period: { start: string | null; end: string | null },
  limit: number,
) {
  const rows: ExceptionRow[] = []
  const push = (
    category: ExceptionCategory,
    r: Partial<ExceptionRow> & { detail: string },
  ) => {
    const meta = EXCEPTION_META[category]
    rows.push({
      category,
      label: meta.label,
      severity: meta.severity,
      voucherNo: r.voucherNo ?? null,
      ledgerId: r.ledgerId ?? null,
      journalEntryId: r.journalEntryId ?? null,
      date: r.date ?? null,
      account: r.account ?? null,
      party: r.party ?? null,
      detail: r.detail,
    })
  }
  const asDate = (v: any) => (v ? String(v).slice(0, 10) : null)

  // 1-4) Voucher-level checks reused from the integrity engine so the two views
  // never drift. Each issue string carries its own category prefix.
  const integrity = await getIntegrityView(f, period, 2000)
  for (const iv of integrity.rows) {
    if (iv.status !== "Exception") continue
    const base = { voucherNo: iv.voucherNo, date: iv.date, party: null as string | null }
    if (Math.abs(iv.ledgerDebit - iv.ledgerCredit) > 0.01) {
      push("unbalanced", {
        ...base,
        detail: `Ledger voucher not balanced (Dr ${iv.ledgerDebit.toFixed(2)} ≠ Cr ${iv.ledgerCredit.toFixed(2)}).`,
      })
    }
    if (iv.journalDebit === 0 && iv.journalCredit === 0) {
      push("missingJournal", { ...base, detail: `No posted Journal Entries voucher backs this ledger posting.` })
    } else if (
      Math.abs(iv.journalDebit - iv.ledgerDebit) > 0.01 ||
      Math.abs(iv.journalCredit - iv.ledgerCredit) > 0.01
    ) {
      push("journalMismatch", {
        ...base,
        detail: `Journal (Dr ${iv.journalDebit.toFixed(2)}/Cr ${iv.journalCredit.toFixed(2)}) ≠ Ledger (Dr ${iv.ledgerDebit.toFixed(2)}/Cr ${iv.ledgerCredit.toFixed(2)}).`,
      })
    }
    if (iv.sourceAmount != null && Math.abs(iv.sourceAmount - iv.ledgerDebit) > 0.01) {
      push("sourceMismatch", {
        ...base,
        detail: `Source amount ${iv.sourceAmount.toFixed(2)} ≠ posted ledger effect ${iv.ledgerDebit.toFixed(2)}.`,
      })
    }
  }

  const scope = exceptionScope(f, period)

  // 5) Journal Without GL — posted journal lines whose voucher never reached the
  // ledger. Scoped by the same period/FY/source predicates on the journal side.
  const jScope = journalScope(f, period, "je")
  const jWithout = await safe(
    `SELECT je.voucher_no, MIN(je.transaction_date) transaction_date,
            ROUND(COALESCE(SUM(je.debit),0),2) jd, ROUND(COALESCE(SUM(je.credit),0),2) jc
       FROM journal_entries je
      ${whereClause([`COALESCE(je.posting_status,'') = 'Posted'`, ...jScope.conditions, `NOT EXISTS (SELECT 1 FROM general_ledger gl WHERE gl.voucher_no = je.voucher_no)`])}
      GROUP BY je.voucher_no
      ORDER BY MIN(je.transaction_date) DESC
      LIMIT 500`,
    jScope.args,
  )
  for (const r of jWithout) {
    push("journalWithoutGl", {
      voucherNo: String(r.voucher_no),
      date: asDate(r.transaction_date),
      detail: `Posted journal (Dr ${num(r.jd).toFixed(2)}/Cr ${num(r.jc).toFixed(2)}) has no matching General Ledger posting.`,
    })
  }

  // 6) Duplicate GL — the same journal entry posted to the ledger more than once.
  const dupes = await safe(
    `SELECT journal_entry_id, COUNT(*) n, MIN(voucher_no) voucher_no, MIN(transaction_date) transaction_date
       FROM general_ledger
       ${whereClause([`journal_entry_id IS NOT NULL`, `journal_entry_id <> ''`, ...scope.conditions])}
       GROUP BY journal_entry_id
       HAVING COUNT(DISTINCT id) > 1
       ORDER BY MIN(transaction_date) DESC
       LIMIT 500`,
    scope.args,
  )
  for (const r of dupes) {
    push("duplicateGl", {
      voucherNo: r.voucher_no ? String(r.voucher_no) : null,
      journalEntryId: String(r.journal_entry_id),
      date: asDate(r.transaction_date),
      detail: `Journal ${r.journal_entry_id} is posted to the ledger ${r.n} times.`,
    })
  }

  // 7) Account Missing — posted rows with no account attached.
  const missingAcct = await safe(
    `SELECT id, voucher_no, journal_entry_id, transaction_date, party_name
       FROM general_ledger
       ${whereClause([`(account_id IS NULL OR account_id = '' OR account_name IS NULL OR account_name = '')`, ...scope.conditions])}
       ORDER BY transaction_date DESC
       LIMIT 500`,
    scope.args,
  )
  for (const r of missingAcct) {
    push("accountMissing", {
      voucherNo: r.voucher_no ? String(r.voucher_no) : null,
      ledgerId: r.id != null ? String(r.id) : null,
      journalEntryId: r.journal_entry_id ? String(r.journal_entry_id) : null,
      date: asDate(r.transaction_date),
      party: r.party_name ? String(r.party_name) : null,
      detail: `Posted ledger row has no account attached.`,
    })
  }

  // 8) Invalid Account — an account_id that is not in the Chart of Accounts.
  const glScope = exceptionScope(f, period, "gl")
  const invalidAcct = await safe(
    `SELECT gl.id, gl.voucher_no, gl.journal_entry_id, gl.transaction_date, gl.account_id, gl.account_name
       FROM general_ledger gl
       LEFT JOIN chart_of_accounts coa ON coa.id = gl.account_id
       ${whereClause([`gl.account_id IS NOT NULL`, `gl.account_id <> ''`, `coa.id IS NULL`, ...glScope.conditions])}
       ORDER BY gl.transaction_date DESC
       LIMIT 500`,
    glScope.args,
  ).catch(() => [] as any[])
  for (const r of invalidAcct) {
    push("invalidAccount", {
      voucherNo: r.voucher_no ? String(r.voucher_no) : null,
      ledgerId: r.id != null ? String(r.id) : null,
      journalEntryId: r.journal_entry_id ? String(r.journal_entry_id) : null,
      date: asDate(r.transaction_date),
      account: r.account_name ? String(r.account_name) : String(r.account_id),
      detail: `Account "${r.account_name || r.account_id}" is not present in the Chart of Accounts.`,
    })
  }

  // 9-10) GST / TDS mismatch — per-voucher tax posted to the ledger vs the
  // posted journal it came from.
  const taxRows = await safe(
    `SELECT g.voucher_no, g.transaction_date,
            g.gst gg, g.tds gt, j.gst jg, j.tds jt
       FROM (SELECT voucher_no, MIN(transaction_date) transaction_date,
                    ROUND(COALESCE(SUM(gst_amount),0),2) gst, ROUND(COALESCE(SUM(tds_amount),0),2) tds
               FROM general_ledger ${whereClause(scope.conditions)}
              GROUP BY voucher_no) g
       JOIN (SELECT voucher_no,
                    ROUND(COALESCE(SUM(gst_amount),0),2) gst, ROUND(COALESCE(SUM(tds_amount),0),2) tds
               FROM journal_entries WHERE COALESCE(posting_status,'') = 'Posted'
              GROUP BY voucher_no) j ON j.voucher_no = g.voucher_no
      WHERE ABS(g.gst - j.gst) > 0.01 OR ABS(g.tds - j.tds) > 0.01
      ORDER BY g.transaction_date DESC
      LIMIT 500`,
    scope.args,
  )
  for (const r of taxRows) {
    if (Math.abs(num(r.gg) - num(r.jg)) > 0.01) {
      push("gstMismatch", {
        voucherNo: String(r.voucher_no),
        date: asDate(r.transaction_date),
        detail: `Ledger GST ${num(r.gg).toFixed(2)} ≠ journal GST ${num(r.jg).toFixed(2)}.`,
      })
    }
    if (Math.abs(num(r.gt) - num(r.jt)) > 0.01) {
      push("tdsMismatch", {
        voucherNo: String(r.voucher_no),
        date: asDate(r.transaction_date),
        detail: `Ledger TDS ${num(r.gt).toFixed(2)} ≠ journal TDS ${num(r.jt).toFixed(2)}.`,
      })
    }
  }

  // 11) Bank Mismatch — reuse the bank reconciliation engine's verdicts.
  try {
    const bank = await getBankReconciliation(f, period)
    for (const b of (bank.rows as BankReconRow[]) || []) {
      if (b.status === "Mismatch" || b.status === "Needs Review") {
        const bad = Object.entries(b.fields)
          .filter(([, ok]) => !ok)
          .map(([k]) => k)
        push("bankMismatch", {
          ledgerId: b.matched?.ledgerId ?? null,
          date: b.date,
          account: b.account,
          party: b.party,
          detail: b.matched
            ? `Bank vs ledger differ on ${bad.length ? bad.join(", ") : "matching"}.`
            : `Bank transaction has no matching ledger entry.`,
        })
      }
    }
  } catch {
    // bank ledger optional
  }

  // 12) Period Lock Issue — posted rows dated inside a locked period.
  try {
    const locks = await listPeriodLocks()
    const lockedKeys = new Set(
      (locks || [])
        .filter((l: any) => String(l.status || l.lock_status || "").toLowerCase() === "locked")
        .map((l: any) => String(l.period_key || l.period || l.month || "")),
    )
    lockedKeys.delete("")
    if (lockedKeys.size) {
      const keyList = Array.from(lockedKeys)
      const ph = keyList.map(() => "?").join(",")
      const locked = await safe(
        `SELECT id, voucher_no, journal_entry_id, transaction_date, account_name,
                DATE_FORMAT(transaction_date,'%Y-%m') period_key
           FROM general_ledger
           ${whereClause([`DATE_FORMAT(transaction_date,'%Y-%m') IN (${ph})`, ...scope.conditions])}
           ORDER BY transaction_date DESC
           LIMIT 500`,
        [...keyList, ...scope.args],
      )
      for (const r of locked) {
        push("periodLock", {
          voucherNo: r.voucher_no ? String(r.voucher_no) : null,
          ledgerId: r.id != null ? String(r.id) : null,
          journalEntryId: r.journal_entry_id ? String(r.journal_entry_id) : null,
          date: asDate(r.transaction_date),
          account: r.account_name ? String(r.account_name) : null,
          detail: `Posting sits in locked period ${r.period_key}.`,
        })
      }
    }
  } catch {
    // period locks optional
  }

  // 13) Unreconciled — posted rows still awaiting reconciliation (capped list;
  // the category count reflects the full total).
  const [unreconTotal] = await safe(
    `SELECT COUNT(*) n FROM general_ledger
      ${whereClause([`COALESCE(reconciliation_status,'Unreconciled') = 'Unreconciled'`, ...scope.conditions])}`,
    scope.args,
  )
  const unrecon = await safe(
    `SELECT id, voucher_no, journal_entry_id, transaction_date, account_name, party_name
       FROM general_ledger
       ${whereClause([`COALESCE(reconciliation_status,'Unreconciled') = 'Unreconciled'`, ...scope.conditions])}
       ORDER BY transaction_date DESC
       LIMIT 200`,
    scope.args,
  )
  for (const r of unrecon) {
    push("unreconciled", {
      voucherNo: r.voucher_no ? String(r.voucher_no) : null,
      ledgerId: r.id != null ? String(r.id) : null,
      journalEntryId: r.journal_entry_id ? String(r.journal_entry_id) : null,
      date: asDate(r.transaction_date),
      account: r.account_name ? String(r.account_name) : null,
      party: r.party_name ? String(r.party_name) : null,
      detail: `Ledger posting is not yet reconciled.`,
    })
  }

  // Assemble category counts. Every category listed so the UI can render a full,
  // zero-inclusive taxonomy. Unreconciled reflects its true total, not the cap.
  const byCategory: Record<ExceptionCategory, number> = {
    unbalanced: 0, missingJournal: 0, journalMismatch: 0, journalWithoutGl: 0,
    duplicateGl: 0, accountMissing: 0, invalidAccount: 0, sourceMismatch: 0,
    gstMismatch: 0, tdsMismatch: 0, bankMismatch: 0, periodLock: 0, unreconciled: 0,
  }
  for (const r of rows) byCategory[r.category] += 1
  byCategory.unreconciled = Number(unreconTotal?.n) || byCategory.unreconciled

  const categories = (Object.keys(EXCEPTION_META) as ExceptionCategory[]).map((key) => ({
    key,
    label: EXCEPTION_META[key].label,
    severity: EXCEPTION_META[key].severity,
    count: byCategory[key],
  }))

  const severityRank = { high: 0, medium: 1, low: 2 } as const
  rows.sort((a, b) => {
    if (a.severity !== b.severity) return severityRank[a.severity] - severityRank[b.severity]
    return String(b.date ?? "").localeCompare(String(a.date ?? ""))
  })

  const total = rows.length
  const capped = rows.slice(0, Math.max(1, Math.min(limit, 2000)))
  return { rows: capped, categories, counts: { total, byCategory }, truncated: total > capped.length }
}

// ---------------------------------------------------------------------------
// Public entry point — one call assembles the requested view plus the shared
// dashboard cards and filter options.
// ---------------------------------------------------------------------------
export type GLView =
  | "ledger"
  | "party"
  | "project"
  | "monthly"
  | "reconciliation"
  | "bank"
  | "integrity"
  | "account"
  | "exceptions"

export async function getGeneralLedger(view: GLView, f: GLFilters, opts: { limit?: number } = {}) {
  const period = resolvePeriod(f)
  const limit = opts.limit ?? 500

  const [cards, filterOptions] = await Promise.all([getCards(f, period), getFilterOptions()])

  let payload: Record<string, any> = {}
  if (view === "party") payload = await getPartyLedger(f, period)
  else if (view === "project") payload = await getProjectLedger(f, period)
  else if (view === "monthly") payload = await getMonthlyLedger(f, period)
  else if (view === "reconciliation") payload = await getReconciliationView(f, period, limit)
  else if (view === "bank") payload = await getBankReconciliation(f, period)
  else if (view === "integrity") payload = await getIntegrityView(f, period, limit)
  else if (view === "account") payload = await getAccountLedger(f, period)
  else if (view === "exceptions") payload = await getExceptionsView(f, period, limit)
  else payload = await getLedgerView(f, period, limit)

  return { view, cards, filterOptions, period, ...payload }
}
