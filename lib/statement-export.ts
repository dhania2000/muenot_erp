/**
 * Shared, client-safe flattening for the four core financial statements.
 *
 * This is the single bridge between the classification-aware statement engine
 * (lib/finance-statements.ts) and every presentation surface that renders a
 * statement as a tabular report: the Financial Reports catalogue (server-side,
 * via lib/finance-report-run.ts) and the Financial Statements page export
 * (client-side). Keeping the column definitions + row flattening here means the
 * statement shown on the dedicated page, the same statement run from the
 * reports hub, its PDF/Excel/CSV export and its emailed copy are all produced
 * from ONE definition — there is no second statement layout to drift.
 *
 * Must stay free of server-only / browser-only imports.
 */

import type { ReportColumn } from "@/lib/report-tally"

export type StatementType = "trial-balance" | "profit-loss" | "balance-sheet" | "cash-flow"

type StatementLine = {
  account_id?: string
  account_code?: string | null
  account_name: string
  amount: number
}
type StatementGroup = { group: string; total: number; lines: StatementLine[] }

/** Column layouts, shared by the catalogue report defs and the page export. */
export const STATEMENT_COLUMNS: Record<StatementType, ReportColumn[]> = {
  "trial-balance": [
    { key: "account_code", label: "Code" },
    { key: "account_name", label: "Account" },
    { key: "group", label: "Group" },
    { key: "debit", label: "Debit", align: "right", money: true },
    { key: "credit", label: "Credit", align: "right", money: true },
  ],
  "profit-loss": [
    { key: "section", label: "Section" },
    { key: "particulars", label: "Particulars" },
    // Own subtotal/total rows are emitted as data, so this column is not
    // auto-totalled (that would double-count the net line).
    { key: "amount", label: "Amount", align: "right", money: true, total: false },
  ],
  "balance-sheet": [
    { key: "section", label: "Section" },
    { key: "particulars", label: "Particulars" },
    { key: "amount", label: "Amount", align: "right", money: true, total: false },
  ],
  "cash-flow": [
    { key: "section", label: "Activity" },
    { key: "particulars", label: "Particulars" },
    { key: "amount", label: "Amount", align: "right", money: true, total: false },
  ],
}

export const STATEMENT_META: Record<StatementType, { label: string; fileStem: string }> = {
  "trial-balance": { label: "Trial Balance", fileStem: "trial-balance" },
  "profit-loss": { label: "Profit & Loss", fileStem: "profit-and-loss" },
  "balance-sheet": { label: "Balance Sheet", fileStem: "balance-sheet" },
  "cash-flow": { label: "Cash Flow Statement", fileStem: "cash-flow" },
}

type Row = Record<string, any>

const lineLabel = (l: StatementLine) =>
  l.account_code ? `${l.account_code}  ${l.account_name}` : l.account_name

/** Render one statement group (header → lines → subtotal) into report rows. */
function pushGroup(rows: Row[], g: StatementGroup, section = "") {
  rows.push({ section, particulars: g.group, amount: null })
  for (const l of g.lines) rows.push({ section: "", particulars: lineLabel(l), amount: l.amount })
  rows.push({ section: "", particulars: `Subtotal — ${g.group}`, amount: g.total })
}

/**
 * Flatten a computed statement into the report row model. `data` is the shape
 * returned by the matching compute* function in lib/finance-statements.ts.
 */
export function flattenStatement(type: StatementType, data: any): { columns: ReportColumn[]; rows: Row[] } {
  const columns = STATEMENT_COLUMNS[type]
  const rows: Row[] = []
  if (!data) return { columns, rows }

  if (type === "trial-balance") {
    for (const r of data.rows ?? []) {
      rows.push({
        account_code: r.account_code ?? "",
        account_name: r.account_name,
        group: r.group,
        debit: r.debit || 0,
        credit: r.credit || 0,
      })
    }
    return { columns, rows }
  }

  if (type === "profit-loss") {
    rows.push({ section: "Income", particulars: "Income", amount: null })
    for (const g of data.income ?? []) pushGroup(rows, g)
    rows.push({ section: "", particulars: "Total Income", amount: data.total_income })
    rows.push({ section: "Expense", particulars: "Expenses", amount: null })
    for (const g of data.expense ?? []) pushGroup(rows, g)
    rows.push({ section: "", particulars: "Total Expenses", amount: data.total_expense })
    const net = Number(data.net_profit) || 0
    rows.push({ section: "", particulars: net >= 0 ? "Net Profit" : "Net Loss", amount: Math.abs(net) })
    return { columns, rows }
  }

  if (type === "balance-sheet") {
    rows.push({ section: "Assets", particulars: "Assets", amount: null })
    for (const g of data.assets ?? []) pushGroup(rows, g)
    rows.push({ section: "", particulars: "Total Assets", amount: data.total_assets })
    rows.push({ section: "Liabilities & Equity", particulars: "Liabilities & Equity", amount: null })
    for (const g of [...(data.liabilities ?? []), ...(data.equity ?? [])]) pushGroup(rows, g)
    rows.push({
      section: "",
      particulars: "Total Liabilities & Equity",
      amount: (Number(data.total_liabilities) || 0) + (Number(data.total_equity) || 0),
    })
    return { columns, rows }
  }

  // cash-flow
  rows.push({ section: "", particulars: "Opening Cash & Bank", amount: data.opening_cash })
  for (const a of data.activities ?? []) {
    rows.push({ section: a.activity, particulars: `${a.activity} Activities`, amount: null })
    for (const l of a.lines ?? []) rows.push({ section: "", particulars: lineLabel(l), amount: l.amount })
    rows.push({ section: "", particulars: `Subtotal — ${a.activity}`, amount: a.total })
  }
  rows.push({ section: "", particulars: "Net Change in Cash", amount: data.net_change })
  rows.push({ section: "", particulars: "Closing Cash & Bank", amount: data.closing_cash })
  return { columns, rows }
}
