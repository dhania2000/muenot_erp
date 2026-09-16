import "server-only"
import { query, tableColumns } from "@/lib/db"
import { num, round2 } from "@/lib/finance-calc"
import {
  resolveClassification,
  bsSideForGroup,
  plSideForGroup,
  BS_ASSET_GROUPS,
  BS_LIABILITY_GROUPS,
  PL_INCOME_GROUPS,
  PL_EXPENSE_GROUPS,
  CASHFLOW_GROUPS,
  type CoaLike,
} from "@/lib/finance-classification"

/**
 * Financial-statement engine (server-only).
 *
 * This does NOT create a second accounting system. It is a pure, read-only
 * aggregation over the SAME data every other Finance module already uses:
 *   - `general_ledger`   — the posted double-entry movements, and
 *   - `chart_of_accounts` — the account master + its reporting classification
 *     (via lib/finance-classification.ts, the shared derive/override resolver).
 *
 * From those two tables it computes the four core statements:
 *   - Trial Balance   (cumulative debit/credit per account, as-at a date)
 *   - Profit & Loss   (period movement of Income / Expense accounts)
 *   - Balance Sheet   (cumulative Asset / Liability / Equity, as-at a date)
 *   - Cash Flow       (period cash movement grouped by activity)
 *
 * Year-end closing vouchers (source_module = 'Year-End Closing') are EXCLUDED
 * from the P&L and Cash Flow so a closed year still reports its real operating
 * result, but are INCLUDED in the Balance Sheet and Trial Balance so the
 * post-closing books (Retained Earnings carrying the closed profit) still tie.
 */

export const YEAR_END_SOURCE_MODULE = "Year-End Closing"

const FY_START_MONTH = 4 // Indian financial year — April to March.

/** Turn a financial-year label ("2026-27") into its inclusive date range. */
export function fyRange(fy: string): { from: string; to: string } | null {
  const m = String(fy || "").match(/^(\d{4})-(\d{2})$/)
  if (!m) return null
  const startYear = Number(m[1])
  const from = `${startYear}-${String(FY_START_MONTH).padStart(2, "0")}-01`
  // End = day before the next FY starts.
  const endYear = FY_START_MONTH === 1 ? startYear : startYear + 1
  const endMonth = FY_START_MONTH === 1 ? 12 : FY_START_MONTH - 1
  const lastDay = new Date(endYear, endMonth, 0).getDate()
  const to = `${endYear}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`
  return { from, to }
}

/** The day before a date (exclusive lower bound for "opening" cumulatives). */
function dayBefore(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
}

type Totals = { debit: number; credit: number }

/**
 * Sum general_ledger debit/credit per account_id for the given window.
 *   - `to`   (inclusive upper bound) is optional; omit for all-time.
 *   - `from` (inclusive lower bound) is optional; omit for cumulative.
 *   - `excludeClosing` drops year-end closing vouchers (for P&L / Cash Flow).
 */
async function ledgerTotals(opts: {
  from?: string | null
  to?: string | null
  excludeClosing?: boolean
}): Promise<Map<string, Totals>> {
  // Column-adaptive: only filter on transaction_date / source_module when those
  // columns exist, so an older general_ledger schema still aggregates instead of
  // failing the whole statement (see lib/db.ts tableColumns).
  const cols = await tableColumns("general_ledger")
  const where: string[] = []
  const args: any[] = []
  if (opts.from && cols.has("transaction_date")) {
    where.push("transaction_date >= ?")
    args.push(opts.from)
  }
  if (opts.to && cols.has("transaction_date")) {
    where.push("transaction_date <= ?")
    args.push(opts.to)
  }
  if (opts.excludeClosing && cols.has("source_module")) {
    where.push("(source_module IS NULL OR source_module <> ?)")
    args.push(YEAR_END_SOURCE_MODULE)
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const rows = (await query(
    `SELECT account_id,
            COALESCE(SUM(debit), 0)  AS debit,
            COALESCE(SUM(credit), 0) AS credit
       FROM general_ledger
       ${clause}
      GROUP BY account_id`,
    args,
  )) as any[]
  const map = new Map<string, Totals>()
  for (const r of rows) {
    map.set(String(r.account_id), { debit: round2(num(r.debit)), credit: round2(num(r.credit)) })
  }
  return map
}

type AccountRow = CoaLike & {
  id: number
  account_id: string
  account_code: string | null
  account_name: string
  account_group: string | null
  nature: string | null
  active_status: string | null
}

/**
 * Load the account master (only fields the classifier + statements need).
 *
 * Column-adaptive: the classification/override columns (bs_group, pnl_group,
 * cashflow_group) and merged_into_account_id are newer additions that may not
 * exist on an older chart_of_accounts. Any absent column is selected as NULL so
 * the statement still runs — the classifier already treats a NULL override as
 * "auto-derive" (see lib/finance-classification.ts). Only account_id is truly
 * required; if the table itself is missing the query raises ER_NO_SUCH_TABLE,
 * which the run engine reports as a genuinely missing source.
 */
async function loadAccounts(): Promise<AccountRow[]> {
  const cols = await tableColumns("chart_of_accounts")
  const wanted = [
    "id",
    "account_id",
    "account_code",
    "account_name",
    "account_group",
    "account_type",
    "nature",
    "gst_applicable",
    "tds_applicable",
    "bank_cash_account",
    "bs_group",
    "pnl_group",
    "cashflow_group",
    "active_status",
  ]
  const select = wanted.map((c) => (cols.has(c) ? `\`${c}\`` : `NULL AS \`${c}\``)).join(", ")
  const where = cols.has("merged_into_account_id") ? "WHERE COALESCE(merged_into_account_id, '') = ''" : ""
  return (await query(`SELECT ${select} FROM chart_of_accounts ${where}`)) as any[]
}

const isDebitNatureRow = (acc: AccountRow): boolean => {
  if (acc.nature) return String(acc.nature).toLowerCase() === "debit"
  const g = String(acc.account_group || "").toLowerCase()
  return g === "asset" || g === "expense"
}

export type StatementLine = {
  account_id: string
  account_code: string | null
  account_name: string
  group: string
  amount: number
}

export type TrialBalanceRow = {
  account_id: string
  account_code: string | null
  account_name: string
  group: string
  debit: number
  credit: number
}

export type TrialBalance = {
  as_of: string | null
  rows: TrialBalanceRow[]
  total_debit: number
  total_credit: number
  balanced: boolean
}

/** Trial Balance: cumulative net per account, as-at `to` (all vouchers). */
export async function computeTrialBalance(to?: string | null): Promise<TrialBalance> {
  const [accounts, totals] = await Promise.all([loadAccounts(), ledgerTotals({ to })])
  const rows: TrialBalanceRow[] = []
  let totalDebit = 0
  let totalCredit = 0
  for (const acc of accounts) {
    const t = totals.get(acc.account_id)
    if (!t) continue
    const net = round2(t.debit - t.credit)
    if (net === 0) continue
    const debit = net > 0 ? net : 0
    const credit = net < 0 ? -net : 0
    totalDebit = round2(totalDebit + debit)
    totalCredit = round2(totalCredit + credit)
    rows.push({
      account_id: acc.account_id,
      account_code: acc.account_code,
      account_name: acc.account_name,
      group: String(acc.account_group || "—"),
      debit,
      credit,
    })
  }
  rows.sort((a, b) => String(a.account_code || "").localeCompare(String(b.account_code || "")))
  return {
    as_of: to ?? null,
    rows,
    total_debit: totalDebit,
    total_credit: totalCredit,
    balanced: Math.abs(totalDebit - totalCredit) <= 0.01,
  }
}

export type StatementGroup = {
  group: string
  side: string
  total: number
  lines: StatementLine[]
}

export type ProfitAndLoss = {
  from: string | null
  to: string | null
  income: StatementGroup[]
  expense: StatementGroup[]
  total_income: number
  total_expense: number
  net_profit: number
}

/**
 * Profit & Loss: movement of Income / Expense accounts over [from, to],
 * EXCLUDING year-end closing vouchers so a closed year still shows its results.
 */
export async function computeProfitAndLoss(from?: string | null, to?: string | null): Promise<ProfitAndLoss> {
  const [accounts, totals] = await Promise.all([
    loadAccounts(),
    ledgerTotals({ from, to, excludeClosing: true }),
  ])

  const incomeGroups = new Map<string, StatementLine[]>()
  const expenseGroups = new Map<string, StatementLine[]>()

  for (const acc of accounts) {
    const cls = resolveClassification(acc)
    if (cls.section !== "ProfitAndLoss") continue
    const t = totals.get(acc.account_id)
    if (!t) continue
    const side = plSideForGroup(cls.pnlGroup)
    // Income is a credit-nature figure, expense a debit-nature figure.
    const amount = side === "Income" ? round2(t.credit - t.debit) : round2(t.debit - t.credit)
    if (amount === 0) continue
    const line: StatementLine = {
      account_id: acc.account_id,
      account_code: acc.account_code,
      account_name: acc.account_name,
      group: cls.pnlGroup,
      amount,
    }
    const bucket = side === "Income" ? incomeGroups : expenseGroups
    if (!bucket.has(cls.pnlGroup)) bucket.set(cls.pnlGroup, [])
    bucket.get(cls.pnlGroup)!.push(line)
  }

  const buildGroups = (map: Map<string, StatementLine[]>, order: readonly string[], side: string): StatementGroup[] =>
    order
      .filter((g) => map.has(g))
      .map((g) => {
        const lines = map.get(g)!.sort((a, b) => String(a.account_code || "").localeCompare(String(b.account_code || "")))
        return { group: g, side, total: round2(lines.reduce((s, l) => s + l.amount, 0)), lines }
      })

  const income = buildGroups(incomeGroups, PL_INCOME_GROUPS, "Income")
  const expense = buildGroups(expenseGroups, PL_EXPENSE_GROUPS, "Expense")
  const totalIncome = round2(income.reduce((s, g) => s + g.total, 0))
  const totalExpense = round2(expense.reduce((s, g) => s + g.total, 0))
  return {
    from: from ?? null,
    to: to ?? null,
    income,
    expense,
    total_income: totalIncome,
    total_expense: totalExpense,
    net_profit: round2(totalIncome - totalExpense),
  }
}

export type BalanceSheet = {
  as_of: string | null
  assets: StatementGroup[]
  liabilities: StatementGroup[]
  equity: StatementGroup[]
  total_assets: number
  total_liabilities: number
  total_equity: number
  current_surplus: number
  balanced: boolean
}

/**
 * Balance Sheet as-at `to` (all vouchers). The net Income − Expense to date is
 * surfaced as a "Current Period Surplus/(Deficit)" line under Equity so the
 * statement ties whether or not year-end closing has run:
 *   Assets = Liabilities + Equity + (Income − Expense)
 */
export async function computeBalanceSheet(to?: string | null): Promise<BalanceSheet> {
  const [accounts, totals] = await Promise.all([loadAccounts(), ledgerTotals({ to })])

  const assetGroups = new Map<string, StatementLine[]>()
  const liabilityGroups = new Map<string, StatementLine[]>()
  const equityGroups = new Map<string, StatementLine[]>()
  let incomeToDate = 0
  let expenseToDate = 0

  for (const acc of accounts) {
    const cls = resolveClassification(acc)
    const t = totals.get(acc.account_id)
    if (cls.section === "ProfitAndLoss") {
      if (!t) continue
      const side = plSideForGroup(cls.pnlGroup)
      if (side === "Income") incomeToDate = round2(incomeToDate + (t.credit - t.debit))
      else expenseToDate = round2(expenseToDate + (t.debit - t.credit))
      continue
    }
    if (!t) continue
    const side = bsSideForGroup(cls.bsGroup)
    // Assets are debit-nature; liabilities & equity credit-nature.
    const amount = side === "Assets" ? round2(t.debit - t.credit) : round2(t.credit - t.debit)
    if (amount === 0) continue
    const line: StatementLine = {
      account_id: acc.account_id,
      account_code: acc.account_code,
      account_name: acc.account_name,
      group: cls.bsGroup,
      amount,
    }
    const bucket = side === "Assets" ? assetGroups : side === "Equity" ? equityGroups : liabilityGroups
    if (!bucket.has(cls.bsGroup)) bucket.set(cls.bsGroup, [])
    bucket.get(cls.bsGroup)!.push(line)
  }

  const buildGroups = (map: Map<string, StatementLine[]>, order: readonly string[], side: string): StatementGroup[] =>
    order
      .filter((g) => map.has(g))
      .map((g) => {
        const lines = map.get(g)!.sort((a, b) => String(a.account_code || "").localeCompare(String(b.account_code || "")))
        return { group: g, side, total: round2(lines.reduce((s, l) => s + l.amount, 0)), lines }
      })

  const assets = buildGroups(assetGroups, BS_ASSET_GROUPS, "Assets")
  const equity = buildGroups(equityGroups, ["Capital & Reserves"], "Equity")
  const liabilities = buildGroups(
    liabilityGroups,
    BS_LIABILITY_GROUPS.filter((g) => g !== "Capital & Reserves"),
    "Liabilities",
  )

  const currentSurplus = round2(incomeToDate - expenseToDate)
  // Fold the current-period surplus into Equity as its own reserve line.
  if (currentSurplus !== 0) {
    const surplusLine: StatementLine = {
      account_id: "__current_surplus__",
      account_code: null,
      account_name: "Current Period Surplus / (Deficit)",
      group: "Capital & Reserves",
      amount: currentSurplus,
    }
    const capital = equity.find((g) => g.group === "Capital & Reserves")
    if (capital) {
      capital.lines.push(surplusLine)
      capital.total = round2(capital.total + currentSurplus)
    } else {
      equity.push({
        group: "Capital & Reserves",
        side: "Equity",
        total: currentSurplus,
        lines: [surplusLine],
      })
    }
  }

  const totalAssets = round2(assets.reduce((s, g) => s + g.total, 0))
  const totalLiabilities = round2(liabilities.reduce((s, g) => s + g.total, 0))
  const totalEquity = round2(equity.reduce((s, g) => s + g.total, 0))
  return {
    as_of: to ?? null,
    assets,
    liabilities,
    equity,
    total_assets: totalAssets,
    total_liabilities: totalLiabilities,
    total_equity: totalEquity,
    current_surplus: currentSurplus,
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) <= 0.5,
  }
}

export type CashFlowActivity = {
  activity: string
  total: number
  lines: StatementLine[]
}

export type CashFlow = {
  from: string | null
  to: string | null
  activities: CashFlowActivity[]
  opening_cash: number
  net_change: number
  closing_cash: number
  reconciles: boolean
}

/**
 * Cash Flow over [from, to], EXCLUDING year-end closing vouchers.
 *
 * Cash & Bank accounts (classification group "Cash & Bank") define the cash
 * position. For every non-cash account, its period contribution to cash is
 * (credit − debit) — a source of cash is a net credit — bucketed by the
 * account's Cash Flow activity (Operating / Investing / Financing). By double
 * entry, the sum of those activity flows equals the net movement in cash, which
 * is reconciled against opening (cumulative before `from`) and closing cash.
 */
export async function computeCashFlow(from?: string | null, to?: string | null): Promise<CashFlow> {
  const accounts = await loadAccounts()
  const [periodTotals, openingTotals] = await Promise.all([
    ledgerTotals({ from, to, excludeClosing: true }),
    from ? ledgerTotals({ to: dayBefore(from), excludeClosing: true }) : Promise.resolve(new Map<string, Totals>()),
  ])

  const cashAccountIds = new Set<string>()
  for (const acc of accounts) {
    const cls = resolveClassification(acc)
    if (cls.section === "BalanceSheet" && cls.bsGroup === "Cash & Bank") cashAccountIds.add(acc.account_id)
  }

  const activityMap = new Map<string, StatementLine[]>()
  let netChange = 0
  let openingCash = 0

  for (const acc of accounts) {
    if (cashAccountIds.has(acc.account_id)) {
      const p = periodTotals.get(acc.account_id)
      if (p) netChange = round2(netChange + (p.debit - p.credit))
      const o = openingTotals.get(acc.account_id)
      if (o) openingCash = round2(openingCash + (o.debit - o.credit))
      continue
    }
    const p = periodTotals.get(acc.account_id)
    if (!p) continue
    const flow = round2(p.credit - p.debit)
    if (flow === 0) continue
    const cls = resolveClassification(acc)
    const activity = cls.cashFlowGroup
    if (!activityMap.has(activity)) activityMap.set(activity, [])
    activityMap.get(activity)!.push({
      account_id: acc.account_id,
      account_code: acc.account_code,
      account_name: acc.account_name,
      group: activity,
      amount: flow,
    })
  }

  const activities: CashFlowActivity[] = CASHFLOW_GROUPS.filter((a) => activityMap.has(a)).map((a) => {
    const lines = activityMap.get(a)!.sort((x, y) => String(x.account_code || "").localeCompare(String(y.account_code || "")))
    return { activity: a, total: round2(lines.reduce((s, l) => s + l.amount, 0)), lines }
  })

  const closingCash = round2(openingCash + netChange)
  const activityTotal = round2(activities.reduce((s, a) => s + a.total, 0))
  return {
    from: from ?? null,
    to: to ?? null,
    activities,
    opening_cash: openingCash,
    net_change: netChange,
    closing_cash: closingCash,
    reconciles: Math.abs(activityTotal - netChange) <= 0.5,
  }
}

/** Distinct financial years present in the ledger, newest first, for pickers. */
export async function listLedgerFinancialYears(): Promise<string[]> {
  // Older ledgers may not carry a financial_year column — degrade to no picker
  // options rather than failing the caller.
  const cols = await tableColumns("general_ledger")
  if (!cols.has("financial_year")) return []
  const rows = (await query(
    `SELECT DISTINCT financial_year FROM general_ledger
      WHERE financial_year IS NOT NULL AND financial_year <> ''
      ORDER BY financial_year DESC`,
  )) as any[]
  return rows.map((r) => String(r.financial_year))
}
