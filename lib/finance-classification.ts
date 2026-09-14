/**
 * Reporting classification for the Chart of Accounts.
 *
 * This is a PURE, client-safe module (no DB, no server-only imports) shared by
 * the COA form, the financial-statements engine and the year-end closing
 * engine. It maps each account onto:
 *   - a Balance Sheet group  (bsGroup)  — for Assets / Liabilities / Equity
 *   - a Profit & Loss group  (pnlGroup) — for Income / Expense
 *   - a Cash Flow group      (Operating / Investing / Financing)
 *
 * Values are AUTO-DERIVED from the account's existing fields (type, sub type,
 * code, name and the GST/TDS/Bank flags) so nothing new has to be entered, but
 * every account may carry an explicit override (bs_group / pnl_group /
 * cashflow_group) that wins when present. This never introduces a second
 * accounting system — it only tags the SAME accounts for statement grouping.
 */

export type CoaLike = {
  account_group?: string | null
  account_type?: string | null
  account_code?: string | null
  account_name?: string | null
  nature?: string | null
  gst_applicable?: unknown
  tds_applicable?: unknown
  bank_cash_account?: unknown
  bs_group?: string | null
  pnl_group?: string | null
  cashflow_group?: string | null
}

export type StatementSection = "BalanceSheet" | "ProfitAndLoss"
export type CashFlowGroup = "Operating" | "Investing" | "Financing"

/** Balance Sheet groups, in presentation order within their side. */
export const BS_ASSET_GROUPS = [
  "Fixed Assets",
  "Investments",
  "Current Assets",
  "Cash & Bank",
  "Loans & Advances",
] as const
export const BS_LIABILITY_GROUPS = [
  "Capital & Reserves",
  "Long-Term Liabilities",
  "Current Liabilities",
  "Duties & Taxes",
] as const
export const BS_GROUPS = [...BS_ASSET_GROUPS, ...BS_LIABILITY_GROUPS] as const

/** Profit & Loss groups, in presentation order within their side. */
export const PL_INCOME_GROUPS = ["Revenue from Operations", "Other Income"] as const
export const PL_EXPENSE_GROUPS = ["Cost of Sales", "Operating Expenses", "Other Expenses"] as const
export const PL_GROUPS = [...PL_INCOME_GROUPS, ...PL_EXPENSE_GROUPS] as const

export const CASHFLOW_GROUPS: CashFlowGroup[] = ["Operating", "Investing", "Financing"]

/** Which top-level side a Balance Sheet group belongs to. */
export function bsSideForGroup(group: string): "Assets" | "Liabilities" | "Equity" {
  if ((BS_ASSET_GROUPS as readonly string[]).includes(group)) return "Assets"
  if (group === "Capital & Reserves") return "Equity"
  return "Liabilities"
}

/** Which top-level side a Profit & Loss group belongs to. */
export function plSideForGroup(group: string): "Income" | "Expense" {
  return (PL_INCOME_GROUPS as readonly string[]).includes(group) ? "Income" : "Expense"
}

const truthy = (v: unknown) => v === 1 || v === "1" || v === true || v === "true"
const norm = (v: unknown) => String(v ?? "").trim().toLowerCase()

/** Whether an account belongs on the Balance Sheet or the P&L, by its type. */
export function sectionForAccount(acc: CoaLike): StatementSection {
  const group = norm(acc.account_group)
  if (group === "income" || group === "expense" || group === "revenue") return "ProfitAndLoss"
  return "BalanceSheet"
}

/**
 * Auto-derive the Balance Sheet group for an Asset / Liability / Equity account.
 * Uses the stable system codes first, then the sub type / name / flags.
 */
function deriveBsGroup(acc: CoaLike): string {
  const group = norm(acc.account_group)
  const type = norm(acc.account_type)
  const name = norm(acc.account_name)
  const code = String(acc.account_code ?? "").trim()

  // Stable system heads resolved by code (see SYSTEM_ACCOUNT_CODES).
  const byCode: Record<string, string> = {
    "1000": "Cash & Bank",
    "1010": "Cash & Bank",
    "1200": "Current Assets",
    "1410": "Current Assets", "1420": "Current Assets", "1430": "Current Assets", "1440": "Current Assets",
    "1450": "Current Assets",
    "1460": "Loans & Advances",
    "2000": "Current Liabilities",
    "2110": "Duties & Taxes", "2120": "Duties & Taxes", "2130": "Duties & Taxes", "2140": "Duties & Taxes",
    "2150": "Duties & Taxes",
    "2200": "Current Liabilities",
    "3200": "Capital & Reserves",
    "3900": "Capital & Reserves",
  }
  if (byCode[code]) return byCode[code]

  if (group === "asset") {
    if (truthy(acc.bank_cash_account) || /bank|cash/.test(type) || /\bbank\b|\bcash\b/.test(name)) return "Cash & Bank"
    if (/fixed|property|plant|equipment|depreciat|building|machinery|vehicle|furniture/.test(type + " " + name)) return "Fixed Assets"
    if (/invest/.test(type + " " + name)) return "Investments"
    if (/advance|loan|deposit|prepaid/.test(type + " " + name)) return "Loans & Advances"
    return "Current Assets"
  }
  if (group === "equity") return "Capital & Reserves"
  // Liability
  if (/duty|dut(ies)?|tax|gst|tds|cess|vat/.test(type + " " + name) || truthy(acc.gst_applicable) || truthy(acc.tds_applicable))
    return "Duties & Taxes"
  if (/long.?term|term loan|borrow|debenture|mortgage/.test(type + " " + name)) return "Long-Term Liabilities"
  return "Current Liabilities"
}

/**
 * Auto-derive the Profit & Loss group for an Income / Expense account.
 */
function derivePnlGroup(acc: CoaLike): string {
  const group = norm(acc.account_group)
  const type = norm(acc.account_type)
  const name = norm(acc.account_name)
  const code = String(acc.account_code ?? "").trim()

  if (code === "4000") return "Revenue from Operations"
  if (code === "5000") return "Cost of Sales"
  if (code === "5100") return "Operating Expenses"

  if (group === "income" || group === "revenue") {
    if (/other income|interest|dividend|gain|misc|discount received/.test(type + " " + name)) return "Other Income"
    return "Revenue from Operations"
  }
  // Expense
  if (/cost of (goods|sales)|cogs|direct|purchase|material|freight inward/.test(type + " " + name)) return "Cost of Sales"
  if (/other expense|interest|finance cost|loss|donation|written off|prior period/.test(type + " " + name)) return "Other Expenses"
  return "Operating Expenses"
}

/** Auto-derive the Cash Flow activity from the resolved BS/P&L groups. */
function deriveCashFlowGroup(acc: CoaLike, bsGroup: string, section: StatementSection): CashFlowGroup {
  if (section === "BalanceSheet") {
    if (bsGroup === "Fixed Assets" || bsGroup === "Investments") return "Investing"
    if (bsGroup === "Capital & Reserves" || bsGroup === "Long-Term Liabilities") return "Financing"
    return "Operating"
  }
  // P&L accounts flow through operating activities, except finance costs.
  const text = norm(acc.account_type) + " " + norm(acc.account_name)
  if (/interest|finance cost|dividend paid/.test(text)) return "Financing"
  return "Operating"
}

export type ResolvedClassification = {
  section: StatementSection
  bsGroup: string
  pnlGroup: string
  cashFlowGroup: CashFlowGroup
  /** The auto-derived values, before any override is applied. */
  autoBsGroup: string
  autoPnlGroup: string
  autoCashFlowGroup: CashFlowGroup
  /** Whether each field is currently overridden on the account row. */
  bsOverridden: boolean
  pnlOverridden: boolean
  cashFlowOverridden: boolean
}

/**
 * Resolve the effective classification for an account: auto-derived values with
 * any stored override applied on top. Safe to call on a partial row.
 */
export function resolveClassification(acc: CoaLike): ResolvedClassification {
  const section = sectionForAccount(acc)
  const autoBsGroup = deriveBsGroup(acc)
  const autoPnlGroup = derivePnlGroup(acc)
  const autoCashFlowGroup = deriveCashFlowGroup(acc, autoBsGroup, section)

  const bsOv = String(acc.bs_group ?? "").trim()
  const pnlOv = String(acc.pnl_group ?? "").trim()
  const cfOv = String(acc.cashflow_group ?? "").trim()

  const bsGroup = (BS_GROUPS as readonly string[]).includes(bsOv) ? bsOv : autoBsGroup
  const pnlGroup = (PL_GROUPS as readonly string[]).includes(pnlOv) ? pnlOv : autoPnlGroup
  const cashFlowGroup = (CASHFLOW_GROUPS as string[]).includes(cfOv) ? (cfOv as CashFlowGroup) : autoCashFlowGroup

  return {
    section,
    bsGroup,
    pnlGroup,
    cashFlowGroup,
    autoBsGroup,
    autoPnlGroup,
    autoCashFlowGroup,
    bsOverridden: bsGroup !== autoBsGroup,
    pnlOverridden: pnlGroup !== autoPnlGroup,
    cashFlowOverridden: cashFlowGroup !== autoCashFlowGroup,
  }
}
