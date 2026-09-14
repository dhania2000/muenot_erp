import "server-only"
import { query } from "@/lib/db"
import { num, round2, financialYearFor } from "@/lib/finance-calc"
import { postLines, type PostingLine, type PostingResult } from "@/lib/finance-posting"
import { natureForAccountType } from "@/lib/finance-module-configs"

/**
 * Opening-balance accounting — requirements 14 & 15.
 *
 * An opening balance is never left as a bare number on `chart_of_accounts`. It
 * is projected into a real, balanced double-entry voucher (Journal + General
 * Ledger) so the books actually balance and the opening figure carries a full
 * audit trail (date, amount, debit/credit side, reference, voucher). The contra
 * side always lands on the system "Opening Balance Equity" head (code 3900), so
 * the sum of every account's opening balance nets to zero across the ledger:
 *
 *   Dr  <account>                opening balance  (natural side = its nature)
 *       Cr  Opening Balance Equity  opening balance
 *
 * (reversed when the account's natural side is Credit).
 *
 * Keyed off `ob_voucher_no` + `ob_posted_amount` + `ob_posted_side` on the
 * account row, exactly like syncExpensePosting / syncPurchaseBillPosting, so it
 * is idempotent: it never double-posts, re-posts cleanly when the amount/side
 * changes, and reverses when the opening balance is cleared.
 */

const OB_EQUITY_CODE = "3900"

let obEquityEnsured = false

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

/** Normalise a stored side value to the strict "Debit" | "Credit" union. */
function normaliseSide(value: unknown, accountGroup: unknown): "Debit" | "Credit" {
  const v = String(value || "").trim()
  if (v === "Debit" || v === "Credit") return v
  return natureForAccountType(String(accountGroup || "Asset")) === "Credit" ? "Credit" : "Debit"
}

/** Build and post (or reverse) the balanced opening-balance voucher. */
async function postOpeningBalance(
  acc: Record<string, any>,
  amount: number,
  side: "Debit" | "Credit",
  date: string,
  financialYear: string | null,
  opts: { createdBy?: number | null; reverse?: boolean },
): Promise<PostingResult> {
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
      ? `Reversal of opening balance for ${acc.account_name} (${acc.account_id})`
      : `Opening balance for ${acc.account_name} (${acc.account_id})`,
    sourceModule: "Opening Balance",
    createdBy: opts.createdBy ?? null,
    reverse: opts.reverse,
  })
}

export type OpeningBalanceSyncResult = {
  action: "posted" | "reposted" | "reversed" | "skipped" | "error"
  voucherNo?: string
  amount?: number
  side?: "Debit" | "Credit"
}

/**
 * Idempotently keep an account's opening-balance voucher in sync with its
 * stored opening balance:
 *   - amount <= 0            → reverse any existing voucher (opening balance cleared);
 *   - unchanged amount+side  → no-op;
 *   - account not Active     → skip posting (never post to an inactive/archived
 *                              account — requirement 13) while leaving any prior
 *                              historical voucher intact (requirement 20);
 *   - changed / not yet posted → reverse the old voucher (if any) and post fresh.
 *
 * Failures are swallowed so a posting error never blocks Chart-of-Accounts CRUD;
 * the next save re-attempts.
 */
export async function syncOpeningBalancePosting(
  accountId: string,
  opts: { createdBy?: number | null } = {},
): Promise<OpeningBalanceSyncResult> {
  await ensureOpeningBalanceEquityAccount()

  const [acc] = (await query(`SELECT * FROM chart_of_accounts WHERE account_id = ? LIMIT 1`, [accountId])) as any[]
  if (!acc) return { action: "skipped" }
  // The equity contra never carries its own opening balance.
  if (String(acc.account_code) === OB_EQUITY_CODE) return { action: "skipped" }

  const amount = round2(num(acc.opening_balance))
  const side = normaliseSide(acc.opening_balance_type, acc.account_group)
  const obDate = (String(acc.opening_balance_date || "").slice(0, 10)) || new Date().toISOString().slice(0, 10)
  const financialYear = acc.financial_year ? String(acc.financial_year) : financialYearFor(obDate)
  const active = String(acc.active_status || "Active") === "Active"

  const existingVoucher = acc.ob_voucher_no ? String(acc.ob_voucher_no) : null
  const postedAmount = round2(num(acc.ob_posted_amount))
  const postedSide = normaliseSide(acc.ob_posted_side, acc.account_group)

  const reverseExisting = async () => {
    if (!existingVoucher) return
    await postOpeningBalance(acc, postedAmount, postedSide, obDate, financialYear, {
      createdBy: opts.createdBy ?? null,
      reverse: true,
    })
    await query(
      `UPDATE chart_of_accounts SET ob_voucher_no = NULL, ob_posted_amount = 0, ob_posted_side = NULL WHERE id = ?`,
      [acc.id],
    )
  }

  try {
    if (amount <= 0) {
      if (existingVoucher) {
        await reverseExisting()
        return { action: "reversed" }
      }
      return { action: "skipped" }
    }

    if (existingVoucher && Math.abs(postedAmount - amount) <= 0.01 && postedSide === side) {
      return { action: "skipped", voucherNo: existingVoucher, amount, side }
    }

    // Never create a new posting on a non-active account; leave any prior
    // voucher untouched so archived accounts keep their history.
    if (!active) return { action: "skipped" }

    let reposted = false
    if (existingVoucher) {
      await reverseExisting()
      reposted = true
    }

    const result = await postOpeningBalance(acc, amount, side, obDate, financialYear, {
      createdBy: opts.createdBy ?? null,
    })
    await query(
      `UPDATE chart_of_accounts SET ob_voucher_no = ?, ob_posted_amount = ?, ob_posted_side = ? WHERE id = ?`,
      [result.voucherNo, amount, side, acc.id],
    )
    return { action: reposted ? "reposted" : "posted", voucherNo: result.voucherNo, amount, side }
  } catch (error) {
    console.log("[v0] opening balance posting failed for", accountId, (error as Error)?.message)
    return { action: "error" }
  }
}
