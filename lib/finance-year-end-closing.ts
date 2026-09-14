import "server-only"
import { query } from "@/lib/db"
import { num, round2 } from "@/lib/finance-calc"
import { postLines, type PostingLine } from "@/lib/finance-posting"
import { resolveClassification, plSideForGroup } from "@/lib/finance-classification"
import { fyRange, YEAR_END_SOURCE_MODULE } from "@/lib/finance-statements"

/**
 * Year-end closing engine (server-only) — requirements 61–66.
 *
 * At the end of a financial year the Profit & Loss (Income / Expense) accounts
 * must be flattened back to zero and their net result carried into equity. This
 * engine posts that as a REAL, balanced double-entry voucher through the SAME
 * Journal + General Ledger pipeline (`postLines`) every other module uses — it
 * introduces no parallel accounting store:
 *
 *   For each Income account with a net credit balance:  Dr Income   (to zero it)
 *   For each Expense account with a net debit balance:   Cr Expense  (to zero it)
 *   Balancing line to Retained Earnings:
 *     profit  → Cr Retained Earnings
 *     loss    → Dr Retained Earnings
 *
 * The closed net result therefore lives in the Retained Earnings equity head
 * (a Balance Sheet account), so the post-closing books still balance and the
 * carried-forward equity opens the next year correctly.
 *
 * IDEMPOTENT / REVERSIBLE
 * -----------------------
 * One row per financial year in `coa_year_end_closings` tracks the closing
 * voucher and a JSON snapshot of the exact lines posted. Re-closing reverses the
 * old voucher (using the snapshot, never a re-computed figure) and posts fresh;
 * re-opening reverses and clears the row. Because the reversal uses the stored
 * snapshot, it is exact even though the closing voucher itself writes ledger
 * rows into the P&L accounts.
 */

export const RETAINED_EARNINGS_CODE = "3910"
const RETAINED_EARNINGS_ID = "COA-RETAINED"
const CLOSING_TABLE = "coa_year_end_closings"

let retainedEnsured = false
let tableEnsured = false

/**
 * Ensure the "Retained Earnings" equity head exists (code 3910). It is seeded
 * lazily and flagged `is_system` so it is protected from destructive edits like
 * the other posting-engine control heads.
 */
export async function ensureRetainedEarningsAccount(): Promise<void> {
  if (retainedEnsured) return
  await query(
    `INSERT INTO chart_of_accounts
       (account_id, account_code, account_name, account_group, account_type, nature, active_status, is_system)
     SELECT ?, ?, 'Retained Earnings', 'Equity', 'Reserves & Surplus', 'Credit', 'Active', 1
       FROM DUAL
      WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = ?)`,
    [RETAINED_EARNINGS_ID, RETAINED_EARNINGS_CODE, RETAINED_EARNINGS_CODE],
  )
  // Make sure an existing row is protected + classified as equity reserves.
  await query(
    `UPDATE chart_of_accounts SET is_system = 1 WHERE account_code = ?`,
    [RETAINED_EARNINGS_CODE],
  ).catch(() => {})
  retainedEnsured = true
}

async function ensureClosingTable(): Promise<void> {
  if (tableEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS ${CLOSING_TABLE} (
       id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       financial_year VARCHAR(12) NOT NULL,
       status VARCHAR(12) NOT NULL DEFAULT 'Closed',
       net_profit DECIMAL(18,2) NOT NULL DEFAULT 0,
       total_income DECIMAL(18,2) NOT NULL DEFAULT 0,
       total_expense DECIMAL(18,2) NOT NULL DEFAULT 0,
       voucher_no VARCHAR(40) DEFAULT NULL,
       lines_snapshot MEDIUMTEXT DEFAULT NULL,
       closed_by INT UNSIGNED DEFAULT NULL,
       closed_at TIMESTAMP NULL DEFAULT NULL,
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_year_end_fy (financial_year)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  tableEnsured = true
}

/** Per-account net P&L movement for a financial year, closing lines excluded. */
async function computeClosingLines(fy: string): Promise<{
  lines: PostingLine[]
  totalIncome: number
  totalExpense: number
  netProfit: number
}> {
  const range = fyRange(fy)
  if (!range) throw new Error(`Invalid financial year "${fy}". Use the form 2026-27.`)

  const accounts = (await query(
    `SELECT account_id, account_code, account_name, account_group, account_type, nature,
            gst_applicable, tds_applicable, bank_cash_account, bs_group, pnl_group, cashflow_group,
            active_status
       FROM chart_of_accounts
      WHERE COALESCE(merged_into_account_id, '') = ''`,
  )) as any[]

  const movements = (await query(
    `SELECT account_id,
            COALESCE(SUM(debit), 0)  AS debit,
            COALESCE(SUM(credit), 0) AS credit
       FROM general_ledger
      WHERE transaction_date >= ? AND transaction_date <= ?
        AND (source_module IS NULL OR source_module <> ?)
      GROUP BY account_id`,
    [range.from, range.to, YEAR_END_SOURCE_MODULE],
  )) as any[]
  const moveMap = new Map<string, { debit: number; credit: number }>()
  for (const m of movements) {
    moveMap.set(String(m.account_id), { debit: round2(num(m.debit)), credit: round2(num(m.credit)) })
  }

  const lines: PostingLine[] = []
  let totalIncome = 0
  let totalExpense = 0

  for (const acc of accounts) {
    const cls = resolveClassification(acc)
    if (cls.section !== "ProfitAndLoss") continue
    if (String(acc.active_status || "Active") !== "Active") continue
    const t = moveMap.get(String(acc.account_id))
    if (!t) continue
    const rawNet = round2(t.debit - t.credit) // debit-positive
    if (rawNet === 0) continue
    const side = plSideForGroup(cls.pnlGroup)
    if (side === "Income") totalIncome = round2(totalIncome + (t.credit - t.debit))
    else totalExpense = round2(totalExpense + (t.debit - t.credit))
    // Offset the account back to zero: net debit → credit it; net credit → debit it.
    lines.push({
      role: side === "Income" ? "sales" : "expense",
      accountId: String(acc.account_id),
      debit: rawNet < 0 ? -rawNet : 0,
      credit: rawNet > 0 ? rawNet : 0,
    })
  }

  const netProfit = round2(totalIncome - totalExpense)
  if (lines.length > 0) {
    // Balancing entry to Retained Earnings: profit → credit, loss → debit.
    lines.push({
      role: "opening_balance_equity",
      accountId: RETAINED_EARNINGS_ID,
      debit: netProfit < 0 ? -netProfit : 0,
      credit: netProfit > 0 ? netProfit : 0,
    })
  }

  return { lines, totalIncome, totalExpense, netProfit }
}

async function postClosing(
  fy: string,
  lines: PostingLine[],
  opts: { createdBy?: number | null; reverse?: boolean },
) {
  const range = fyRange(fy)!
  return postLines(lines, {
    entityType: "year_end_closing",
    entityId: 0,
    entityRef: `YEC-${fy}`,
    date: range.to,
    financialYear: fy,
    voucherType: "Year-End Closing",
    narration: opts.reverse
      ? `Reversal of year-end closing for FY ${fy}`
      : `Year-end closing for FY ${fy} — P&L transferred to Retained Earnings`,
    sourceModule: YEAR_END_SOURCE_MODULE,
    createdBy: opts.createdBy ?? null,
    reverse: opts.reverse,
  })
}

export type ClosingStatus = {
  financial_year: string
  status: "Open" | "Closed"
  net_profit: number
  total_income: number
  total_expense: number
  voucher_no: string | null
  closed_at: string | null
}

/** Read the stored closing row for a financial year (if any). */
async function readClosingRow(fy: string): Promise<any | null> {
  await ensureClosingTable()
  const rows = (await query(`SELECT * FROM ${CLOSING_TABLE} WHERE financial_year = ? LIMIT 1`, [fy])) as any[]
  return rows?.[0] ?? null
}

/**
 * Status for a financial year: the stored closed figures when closed, or a live
 * preview of the net result that WOULD be closed when still open.
 */
export async function getClosingStatus(fy: string, opts: { preview?: boolean } = {}): Promise<ClosingStatus> {
  const row = await readClosingRow(fy)
  if (row && row.status === "Closed") {
    return {
      financial_year: fy,
      status: "Closed",
      net_profit: round2(num(row.net_profit)),
      total_income: round2(num(row.total_income)),
      total_expense: round2(num(row.total_expense)),
      voucher_no: row.voucher_no ? String(row.voucher_no) : null,
      closed_at: row.closed_at ? String(row.closed_at) : null,
    }
  }
  if (opts.preview) {
    const { totalIncome, totalExpense, netProfit } = await computeClosingLines(fy)
    return {
      financial_year: fy,
      status: "Open",
      net_profit: netProfit,
      total_income: totalIncome,
      total_expense: totalExpense,
      voucher_no: null,
      closed_at: null,
    }
  }
  return {
    financial_year: fy,
    status: "Open",
    net_profit: 0,
    total_income: 0,
    total_expense: 0,
    voucher_no: null,
    closed_at: null,
  }
}

/** List every recorded closing (newest FY first) for the dashboard. */
export async function listClosings(): Promise<ClosingStatus[]> {
  await ensureClosingTable()
  const rows = (await query(`SELECT * FROM ${CLOSING_TABLE} ORDER BY financial_year DESC`)) as any[]
  return rows.map((row) => ({
    financial_year: String(row.financial_year),
    status: row.status === "Closed" ? "Closed" : "Open",
    net_profit: round2(num(row.net_profit)),
    total_income: round2(num(row.total_income)),
    total_expense: round2(num(row.total_expense)),
    voucher_no: row.voucher_no ? String(row.voucher_no) : null,
    closed_at: row.closed_at ? String(row.closed_at) : null,
  }))
}

/**
 * Close (or re-close) a financial year: reverse any prior closing voucher using
 * its stored snapshot, compute the fresh net result and post the closing
 * voucher, then persist the tracking row. Idempotent and safe to re-run.
 */
export async function closeYear(
  fy: string,
  opts: { createdBy?: number | null } = {},
): Promise<{ ok: boolean; error?: string; status?: ClosingStatus }> {
  if (!fyRange(fy)) return { ok: false, error: `Invalid financial year "${fy}". Use the form 2026-27.` }
  await ensureRetainedEarningsAccount()
  await ensureClosingTable()

  const existing = await readClosingRow(fy)

  try {
    // Unwind a prior closing first (exact reversal from the stored snapshot).
    if (existing?.voucher_no && existing.lines_snapshot) {
      const prevLines = JSON.parse(String(existing.lines_snapshot)) as PostingLine[]
      if (Array.isArray(prevLines) && prevLines.length > 0) {
        await postClosing(fy, prevLines, { createdBy: opts.createdBy ?? null, reverse: true })
      }
    }

    const { lines, totalIncome, totalExpense, netProfit } = await computeClosingLines(fy)
    if (lines.length === 0) {
      // Nothing to close — clear any stale row and report open.
      await query(`DELETE FROM ${CLOSING_TABLE} WHERE financial_year = ?`, [fy]).catch(() => {})
      return { ok: false, error: `No Profit & Loss activity found for FY ${fy}. There is nothing to close.` }
    }

    const result = await postClosing(fy, lines, { createdBy: opts.createdBy ?? null })

    await query(
      `INSERT INTO ${CLOSING_TABLE}
         (financial_year, status, net_profit, total_income, total_expense, voucher_no, lines_snapshot, closed_by, closed_at)
       VALUES (?, 'Closed', ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         status = 'Closed', net_profit = VALUES(net_profit), total_income = VALUES(total_income),
         total_expense = VALUES(total_expense), voucher_no = VALUES(voucher_no),
         lines_snapshot = VALUES(lines_snapshot), closed_by = VALUES(closed_by), closed_at = NOW()`,
      [fy, netProfit, totalIncome, totalExpense, result.voucherNo, JSON.stringify(lines), opts.createdBy ?? null],
    )

    return { ok: true, status: await getClosingStatus(fy) }
  } catch (error) {
    console.log("[v0] year-end close failed for", fy, (error as Error)?.message)
    return { ok: false, error: (error as Error)?.message || "Year-end closing failed." }
  }
}

/**
 * Re-open a closed financial year: reverse the closing voucher (restoring the
 * P&L balances) and remove the tracking row so the year is open again.
 */
export async function reopenYear(
  fy: string,
  opts: { createdBy?: number | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  await ensureClosingTable()
  const existing = await readClosingRow(fy)
  if (!existing || existing.status !== "Closed") {
    return { ok: false, error: `FY ${fy} is not closed.` }
  }
  try {
    if (existing.voucher_no && existing.lines_snapshot) {
      const prevLines = JSON.parse(String(existing.lines_snapshot)) as PostingLine[]
      if (Array.isArray(prevLines) && prevLines.length > 0) {
        await postClosing(fy, prevLines, { createdBy: opts.createdBy ?? null, reverse: true })
      }
    }
    await query(`DELETE FROM ${CLOSING_TABLE} WHERE financial_year = ?`, [fy])
    return { ok: true }
  } catch (error) {
    console.log("[v0] year-end reopen failed for", fy, (error as Error)?.message)
    return { ok: false, error: (error as Error)?.message || "Re-open failed." }
  }
}
