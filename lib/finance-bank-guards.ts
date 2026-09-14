import "server-only"
import { query } from "@/lib/db"
import { assertPeriodOpen, PeriodLockedError, periodKeyFor } from "@/lib/finance-period-lock"

/**
 * Server-side write guards for the Bank & Cash area. These run BEFORE any row
 * is written (from the CRUD factory) and return a human-readable error string
 * to reject the request with 400, or null to allow it. They are deliberately
 * kept side-effect free so a rejected request never mutates state.
 */

type AccountRow = { finance_account_id: string; account_name: string | null; active_status: string | null }

/** Look up a Bank & Cash account's status by its business id (BANK-0001 …). */
async function accountStatus(id?: string | null): Promise<AccountRow | null> {
  const key = String(id ?? "").trim()
  if (!key) return null
  const [row] = (await query(
    `SELECT finance_account_id, account_name, active_status
       FROM finance_accounts WHERE finance_account_id = ? LIMIT 1`,
    [key],
  )) as any[]
  return row ?? null
}

/**
 * Guard a bank-transaction create/edit. Blocks two illegal writes:
 *  1. Posting into a locked financial period (the same period-lock the expense
 *     and payment engines already honour), and
 *  2. Any movement whose account — or transfer counter-account — is Closed.
 * Imported statement rows come through the importer, not this CRUD path, so
 * they are unaffected.
 */
export async function guardBankTransactionWrite(merged: Record<string, any>): Promise<string | null> {
  try {
    await assertPeriodOpen(merged.transaction_date)
  } catch (error) {
    if (error instanceof PeriodLockedError) {
      const period = periodKeyFor(merged.transaction_date) || "the selected month"
      return `The financial period ${period} is locked. Unlock it before posting or editing a transaction dated in that month.`
    }
    throw error
  }

  const checks: Array<[string | null | undefined, string]> = [
    [merged.bank_cash_account_id, "account"],
    [merged.counter_account_id, "counter account"],
  ]
  for (const [id, label] of checks) {
    const acct = await accountStatus(id)
    if (acct && String(acct.active_status) === "Closed") {
      return `The ${label} ${acct.account_name ?? ""} (${acct.finance_account_id}) is Closed — no new transactions can be posted to it. Reopen the account first.`
    }
  }
  return null
}

/**
 * Pre-close validation for a Bank & Cash account. Only fires on the transition
 * INTO the Closed status; a plain edit to an already-closed (or still-active)
 * account passes straight through. An account may not be closed while it still
 * carries a non-zero book balance or has unreconciled movements, because either
 * would strand money outside the reconciliation workflow.
 */
export async function guardBankAccountClose(
  merged: Record<string, any>,
  existing: Record<string, any> | null | undefined,
): Promise<string | null> {
  const wasClosed = String(existing?.active_status ?? "") === "Closed"
  const nowClosed = String(merged?.active_status ?? "") === "Closed"
  if (!nowClosed || wasClosed) return null

  const accountId = String(existing?.finance_account_id ?? merged?.finance_account_id ?? "").trim()
  if (!accountId) return null

  const [acct] = (await query(
    `SELECT current_book_balance FROM finance_accounts WHERE finance_account_id = ? LIMIT 1`,
    [accountId],
  )) as any[]
  const book = Number(acct?.current_book_balance ?? merged?.current_book_balance ?? 0) || 0
  if (Math.abs(book) > 0.01) {
    return `${accountId} cannot be closed while it holds an outstanding book balance of ${book.toFixed(2)}. Transfer or withdraw the balance to zero first.`
  }

  const [pending] = (await query(
    `SELECT COUNT(*) AS n FROM bank_transactions
       WHERE bank_cash_account_id = ?
         AND COALESCE(reconciliation_status, 'Unreconciled') NOT IN ('Reconciled', 'Excluded')`,
    [accountId],
  )) as any[]
  const n = Number(pending?.n ?? 0)
  if (n > 0) {
    return `${accountId} cannot be closed while ${n} transaction${n === 1 ? "" : "s"} remain unreconciled. Reconcile or exclude them first.`
  }
  return null
}
