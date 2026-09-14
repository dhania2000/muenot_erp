import "server-only"
import { query } from "@/lib/db"
import { num, round2, financialYearFor } from "@/lib/finance-calc"
import { postLines, type PostingLine } from "@/lib/finance-posting"
import { natureForAccountType } from "@/lib/finance-module-configs"

/**
 * Opening-balance accounting — requirements 14 & 15, extended to full
 * per-financial-year opening balances.
 *
 * An opening balance is never left as a bare number. Each opening balance is
 * projected into a real, balanced double-entry voucher (Journal + General
 * Ledger) so the books actually balance and the figure carries a full audit
 * trail (date, amount, debit/credit side, reference, voucher). The contra side
 * always lands on the system "Opening Balance Equity" head (code 3900), so the
 * sum of every opening balance nets to zero across the ledger:
 *
 *   Dr  <account>                opening balance  (natural side = its nature)
 *       Cr  Opening Balance Equity  opening balance
 *
 * (reversed when the account's natural side is Credit).
 *
 * PER-YEAR MODEL
 * --------------
 * An account can carry a distinct opening balance for every financial year it
 * has been open. Those live in `coa_opening_balances`, one row per
 * (account_id, financial_year), each keyed by its own
 * `ob_voucher_no` + `ob_posted_amount` + `ob_posted_side` so every year's
 * voucher posts, re-posts and reverses independently and idempotently.
 *
 * The `chart_of_accounts.opening_balance / opening_balance_type /
 * opening_balance_date / financial_year` columns remain the account's PRIMARY
 * (default) year and stay the single value shown in the master list, the
 * summary KPI, the exports and the 360° view. On every sync that primary entry
 * is mirrored into the per-year table so the two never drift, and then every
 * year's voucher is brought in line with its stored figure. No downstream
 * linkage changes — Journal, General Ledger, Purchase Bills, Sales Invoices,
 * Expenses, Bank & Cash, GST, TDS and Reports all still resolve accounts by
 * `account_id` / `account_code`, none of which move.
 */

const OB_EQUITY_CODE = "3900"
const OB_TABLE = "coa_opening_balances"

let obEquityEnsured = false
let obTableEnsured = false

/**
 * Ensure the "Opening Balance Equity" control head exists so every opening
 * balance has a contra to post against. Idempotent and seeded lazily; the code
 * (3900) is flagged `is_system` by ensureChartOfAccountsColumns so it is
 * protected from destructive edits like every other posting-engine head.
 */
export async function ensureOpeningBalanceEquityAccount(): Promise<void> {
  if (obEquityEnsured) return
  await query(
    `INSERT INTO chart_of_accounts
       (account_id, account_code, account_name, account_group, account_type, nature, active_status)
     SELECT 'COA-OB-EQUITY', ?, 'Opening Balance Equity', 'Equity', 'Equity', 'Credit', 'Active'
       FROM DUAL
      WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.account_code = ?)`,
    [OB_EQUITY_CODE, OB_EQUITY_CODE],
  )
  obEquityEnsured = true
}

/**
 * Self-healing schema + backfill for the per-year opening-balance store. The
 * table holds one row per (account_id, financial_year). On first use it also
 * migrates any legacy single opening balance held directly on
 * `chart_of_accounts` into its financial-year row, carrying over the posting
 * tracking columns so an already-posted opening balance is recognised and NOT
 * re-posted or duplicated. Idempotent and runs once per process.
 */
export async function ensureOpeningBalanceTable(): Promise<void> {
  if (obTableEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS ${OB_TABLE} (
       id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       account_id VARCHAR(40) NOT NULL,
       financial_year VARCHAR(12) NOT NULL,
       opening_balance DECIMAL(18,2) NOT NULL DEFAULT 0,
       opening_balance_type VARCHAR(10) DEFAULT NULL,
       opening_balance_date DATE DEFAULT NULL,
       ob_voucher_no VARCHAR(40) DEFAULT NULL,
       ob_posted_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
       ob_posted_side VARCHAR(10) DEFAULT NULL,
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_coa_ob_year (account_id, financial_year),
       KEY idx_coa_ob_account (account_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // Backfill legacy single opening balances (with their posted-voucher state so
  // they are never re-posted). Done in JS so the financial year can be derived
  // from the opening-balance date when the column is blank.
  try {
    const legacy = (await query(
      `SELECT account_id, account_code, account_group, opening_balance, opening_balance_type,
              opening_balance_date, financial_year, ob_voucher_no, ob_posted_amount, ob_posted_side
         FROM chart_of_accounts
        WHERE (opening_balance <> 0 OR (ob_voucher_no IS NOT NULL AND ob_voucher_no <> ''))
          AND account_code <> ?`,
      [OB_EQUITY_CODE],
    )) as any[]
    for (const a of legacy) {
      const date = String(a.opening_balance_date || "").slice(0, 10)
      const fy = (a.financial_year ? String(a.financial_year) : "") || financialYearFor(date)
      if (!fy) continue
      await query(
        `INSERT INTO ${OB_TABLE}
           (account_id, financial_year, opening_balance, opening_balance_type, opening_balance_date,
            ob_voucher_no, ob_posted_amount, ob_posted_side)
         VALUES (?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE account_id = account_id`,
        [
          String(a.account_id),
          fy,
          round2(num(a.opening_balance)),
          normaliseSide(a.opening_balance_type, a.account_group),
          date || null,
          a.ob_voucher_no || null,
          round2(num(a.ob_posted_amount)),
          a.ob_posted_side || null,
        ],
      )
    }
  } catch (error) {
    console.log("[v0] opening-balance backfill skipped:", (error as Error)?.message)
  }

  obTableEnsured = true
}

/** Normalise a stored side value to the strict "Debit" | "Credit" union. */
function normaliseSide(value: unknown, accountGroup: unknown): "Debit" | "Credit" {
  const v = String(value || "").trim()
  if (v === "Debit" || v === "Credit") return v
  return natureForAccountType(String(accountGroup || "Asset")) === "Credit" ? "Credit" : "Debit"
}

/** First day of a financial year label (e.g. "2026-27" → "2026-04-01"). */
function defaultDateForFy(fy: string): string {
  const m = String(fy || "").match(/^(\d{4})/)
  if (m) return `${m[1]}-04-01`
  return new Date().toISOString().slice(0, 10)
}

/** Build and post (or reverse) the balanced opening-balance voucher. */
async function postOpeningBalance(
  acc: Record<string, any>,
  amount: number,
  side: "Debit" | "Credit",
  date: string,
  financialYear: string | null,
  opts: { createdBy?: number | null; reverse?: boolean },
) {
  const isDebit = side === "Debit"
  const lines: PostingLine[] = [
    {
      // Account side posts to this exact head via its explicit account id.
      role: "opening_balance_equity",
      accountId: String(acc.account_id),
      debit: isDebit ? amount : 0,
      credit: isDebit ? 0 : amount,
    },
    {
      // Contra side resolves the Opening Balance Equity head by role (code 3900).
      role: "opening_balance_equity",
      debit: isDebit ? 0 : amount,
      credit: isDebit ? amount : 0,
    },
  ]
  return postLines(lines, {
    entityType: "opening_balance",
    entityId: Number(acc.id),
    entityRef: String(acc.account_id),
    date,
    financialYear,
    voucherType: "Opening Balance",
    narration: opts.reverse
      ? `Reversal of opening balance for ${acc.account_name} (${acc.account_id})${financialYear ? ` — FY ${financialYear}` : ""}`
      : `Opening balance for ${acc.account_name} (${acc.account_id})${financialYear ? ` — FY ${financialYear}` : ""}`,
    sourceModule: "Opening Balance",
    createdBy: opts.createdBy ?? null,
    reverse: opts.reverse,
  })
}

export type OpeningBalanceSyncResult = {
  action: "posted" | "reposted" | "reversed" | "skipped" | "error" | "synced"
  years?: number
}

type PerYearAction = "posted" | "reposted" | "reversed" | "skipped" | "error"

/**
 * Mirror the account's PRIMARY opening balance (the columns the create/edit form
 * and the bulk import write directly on `chart_of_accounts`) into its
 * financial-year row so the master value and the per-year store never drift.
 * Only the figure/side/date are mirrored — never the posting tracking columns,
 * so an already-posted year keeps its voucher and stays idempotent.
 */
async function mirrorPrimaryEntry(acc: Record<string, any>): Promise<void> {
  const amount = round2(num(acc.opening_balance))
  const date = String(acc.opening_balance_date || "").slice(0, 10)
  const fy = (acc.financial_year ? String(acc.financial_year) : "") || financialYearFor(date)
  // No resolvable year, or nothing to record → do not create an empty row.
  if (!fy) return
  if (amount <= 0) return
  await query(
    `INSERT INTO ${OB_TABLE}
       (account_id, financial_year, opening_balance, opening_balance_type, opening_balance_date)
     VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       opening_balance = VALUES(opening_balance),
       opening_balance_type = VALUES(opening_balance_type),
       opening_balance_date = VALUES(opening_balance_date)`,
    [String(acc.account_id), fy, amount, normaliseSide(acc.opening_balance_type, acc.account_group), date || null],
  )
}

/** Bring a single financial-year opening-balance voucher in line with its row. */
async function syncEntry(
  acc: Record<string, any>,
  entry: Record<string, any>,
  opts: { createdBy?: number | null },
): Promise<PerYearAction> {
  const amount = round2(num(entry.opening_balance))
  const side = normaliseSide(entry.opening_balance_type, acc.account_group)
  const fy = String(entry.financial_year)
  const date = String(entry.opening_balance_date || "").slice(0, 10) || defaultDateForFy(fy)
  const active = String(acc.active_status || "Active") === "Active"

  const existingVoucher = entry.ob_voucher_no ? String(entry.ob_voucher_no) : null
  const postedAmount = round2(num(entry.ob_posted_amount))
  const postedSide = normaliseSide(entry.ob_posted_side, acc.account_group)

  const clearTracking = async () => {
    await query(
      `UPDATE ${OB_TABLE} SET ob_voucher_no = NULL, ob_posted_amount = 0, ob_posted_side = NULL WHERE id = ?`,
      [entry.id],
    )
  }
  const reverseExisting = async () => {
    if (!existingVoucher) return
    await postOpeningBalance(acc, postedAmount, postedSide, date, fy, {
      createdBy: opts.createdBy ?? null,
      reverse: true,
    })
    await clearTracking()
  }

  try {
    if (amount <= 0) {
      if (existingVoucher) {
        await reverseExisting()
        return "reversed"
      }
      return "skipped"
    }

    if (existingVoucher && Math.abs(postedAmount - amount) <= 0.01 && postedSide === side) {
      return "skipped"
    }

    // Never create a new posting on a non-active account; leave any prior
    // voucher untouched so archived accounts keep their history.
    if (!active) return "skipped"

    let reposted = false
    if (existingVoucher) {
      await reverseExisting()
      reposted = true
    }

    const result = await postOpeningBalance(acc, amount, side, date, fy, { createdBy: opts.createdBy ?? null })
    await query(
      `UPDATE ${OB_TABLE} SET ob_voucher_no = ?, ob_posted_amount = ?, ob_posted_side = ? WHERE id = ?`,
      [result.voucherNo, amount, side, entry.id],
    )
    return reposted ? "reposted" : "posted"
  } catch (error) {
    console.log("[v0] opening balance posting failed for", acc.account_id, fy, (error as Error)?.message)
    return "error"
  }
}

/**
 * Idempotently keep every one of an account's per-year opening-balance vouchers
 * in sync with its stored figures:
 *   - mirror the account's primary opening balance into its financial-year row;
 *   - for each year: amount <= 0 reverses any voucher, an unchanged amount+side
 *     is a no-op, a changed/new figure reverses the old and posts fresh, and a
 *     non-Active account is never newly posted (history is preserved);
 *   - clean up zeroed, fully-reversed year rows so they don't linger.
 *
 * Failures per year are swallowed so a posting error never blocks
 * Chart-of-Accounts CRUD; the next save re-attempts.
 */
export async function syncOpeningBalancePosting(
  accountId: string,
  opts: { createdBy?: number | null } = {},
): Promise<OpeningBalanceSyncResult> {
  await ensureOpeningBalanceEquityAccount()
  await ensureOpeningBalanceTable()

  const [acc] = (await query(`SELECT * FROM chart_of_accounts WHERE account_id = ? LIMIT 1`, [accountId])) as any[]
  if (!acc) return { action: "skipped" }
  // The equity contra never carries its own opening balance.
  if (String(acc.account_code) === OB_EQUITY_CODE) return { action: "skipped" }

  try {
    await mirrorPrimaryEntry(acc)
  } catch (error) {
    console.log("[v0] mirror primary opening balance failed:", (error as Error)?.message)
  }

  const entries = (await query(
    `SELECT * FROM ${OB_TABLE} WHERE account_id = ? ORDER BY financial_year ASC, id ASC`,
    [accountId],
  )) as any[]

  let synced = 0
  for (const entry of entries) {
    const action = await syncEntry(acc, entry, opts)
    if (action !== "skipped" && action !== "error") synced++
  }

  // Drop zeroed rows whose voucher has been reversed so the per-year store only
  // keeps real opening balances.
  await query(
    `DELETE FROM ${OB_TABLE} WHERE account_id = ? AND opening_balance <= 0 AND (ob_voucher_no IS NULL OR ob_voucher_no = '')`,
    [accountId],
  ).catch(() => {})

  return { action: "synced", years: entries.length }
}

export type OpeningBalanceYear = {
  financial_year: string
  opening_balance: number
  opening_balance_type: "Debit" | "Credit"
  opening_balance_date: string | null
  voucher_no: string | null
  posted: boolean
}

/** Read every stored per-year opening balance for an account (newest first). */
export async function listOpeningBalances(accountId: string): Promise<OpeningBalanceYear[]> {
  await ensureOpeningBalanceTable()
  const rows = (await query(
    `SELECT financial_year, opening_balance, opening_balance_type, opening_balance_date, ob_voucher_no
       FROM ${OB_TABLE} WHERE account_id = ? ORDER BY financial_year DESC`,
    [accountId],
  )) as any[]
  return rows.map((r) => ({
    financial_year: String(r.financial_year),
    opening_balance: round2(num(r.opening_balance)),
    opening_balance_type: normaliseSide(r.opening_balance_type, "Asset"),
    opening_balance_date: r.opening_balance_date ? String(r.opening_balance_date).slice(0, 10) : null,
    voucher_no: r.ob_voucher_no ? String(r.ob_voucher_no) : null,
    posted: !!r.ob_voucher_no,
  }))
}

export type OpeningBalanceInput = {
  financial_year: string
  opening_balance: number
  opening_balance_date?: string | null
}

/**
 * Replace an account's per-year opening balances with the supplied set, then
 * re-sync every voucher. Years present in the store but absent from the input
 * are zeroed first so their vouchers are reversed, then removed. The entry whose
 * year matches the account's PRIMARY financial year is also written back onto
 * `chart_of_accounts` so the master value, summary KPI and exports stay in step.
 */
export async function saveOpeningBalances(
  accountId: string,
  entries: OpeningBalanceInput[],
  opts: { createdBy?: number | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  await ensureOpeningBalanceTable()

  const [acc] = (await query(`SELECT * FROM chart_of_accounts WHERE account_id = ? LIMIT 1`, [accountId])) as any[]
  if (!acc) return { ok: false, error: "Account not found." }
  if (String(acc.account_code) === OB_EQUITY_CODE) {
    return { ok: false, error: "The Opening Balance Equity control head cannot carry an opening balance." }
  }

  const nature = normaliseSide(acc.nature, acc.account_group)

  // Normalise + de-duplicate by year (last one wins), keeping only positive figures.
  const byYear = new Map<string, OpeningBalanceInput>()
  for (const e of entries) {
    const fy = String(e.financial_year || "").trim()
    if (!/^\d{4}-\d{2}$/.test(fy)) return { ok: false, error: `Invalid financial year "${fy}". Use the form 2026-27.` }
    const amount = round2(num(e.opening_balance))
    if (amount < 0) return { ok: false, error: `Opening balance for ${fy} cannot be negative.` }
    byYear.set(fy, { financial_year: fy, opening_balance: amount, opening_balance_date: e.opening_balance_date ?? null })
  }

  // Upsert the desired years (figure/side/date only — never the tracking columns).
  for (const e of byYear.values()) {
    if (e.opening_balance <= 0) continue
    await query(
      `INSERT INTO ${OB_TABLE}
         (account_id, financial_year, opening_balance, opening_balance_type, opening_balance_date)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         opening_balance = VALUES(opening_balance),
         opening_balance_type = VALUES(opening_balance_type),
         opening_balance_date = VALUES(opening_balance_date)`,
      [accountId, e.financial_year, e.opening_balance, nature, e.opening_balance_date || defaultDateForFy(e.financial_year)],
    )
  }

  // Zero any existing year not in the desired set (or set to 0) so its voucher
  // is reversed on the next sync, then removed by the cleanup step.
  const existing = (await query(`SELECT financial_year FROM ${OB_TABLE} WHERE account_id = ?`, [accountId])) as any[]
  for (const r of existing) {
    const fy = String(r.financial_year)
    const desired = byYear.get(fy)
    if (!desired || desired.opening_balance <= 0) {
      await query(`UPDATE ${OB_TABLE} SET opening_balance = 0 WHERE account_id = ? AND financial_year = ?`, [accountId, fy])
    }
  }

  // Write the account's PRIMARY-year entry back onto chart_of_accounts so the
  // master column stays authoritative for that year. The primary year is the
  // account's current financial_year, or the most recent supplied year.
  const primaryFy =
    (acc.financial_year && byYear.has(String(acc.financial_year)) && String(acc.financial_year)) ||
    [...byYear.keys()].sort().reverse()[0] ||
    ""
  const primary = primaryFy ? byYear.get(primaryFy) : undefined
  await query(
    `UPDATE chart_of_accounts
        SET opening_balance = ?, opening_balance_type = ?, opening_balance_date = ?, financial_year = ?
      WHERE account_id = ?`,
    [
      primary ? primary.opening_balance : 0,
      primary ? nature : acc.opening_balance_type ?? nature,
      primary ? primary.opening_balance_date || defaultDateForFy(primaryFy) : acc.opening_balance_date ?? null,
      primaryFy || acc.financial_year || null,
      accountId,
    ],
  )

  await syncOpeningBalancePosting(accountId, opts)
  return { ok: true }
}
