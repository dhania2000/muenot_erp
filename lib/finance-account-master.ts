import "server-only"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"

// ---------------------------------------------------------------------------
// Bank & Cash account master helpers (server-only).
//
// The Bank & Cash master is the authoritative control center for every
// bank / cash / wallet / UPI account. Two responsibilities live here:
//
//   1. Per-type immutable IDs — a new account gets a prefix that reflects its
//      type (BANK-0001, CASH-0001, WALLET-0001, UPI-0001). Existing ACC- ids
//      are never rewritten (ids are immutable), so this only affects new rows.
//
//   2. Server-authoritative Book Balance — the current book balance is NEVER
//      trusted from the browser. It is recomputed from the account's own bank
//      transactions as:
//
//        Book Balance = Opening Balance + Σ Credits (money in) − Σ Debits (out)
//
//      Statement convention on a bank transaction row (see finance-bank-posting):
//        credit = deposit  / money INTO the account
//        debit  = withdrawal / money OUT of the account
//
//      A bank-to-bank Transfer is stored as a single row against the "from"
//      account (bank_cash_account_id) with the receiving account in
//      counter_account_id, so the receiving side is folded in from the mirror
//      legs. Void / Cancelled / Reversed / Draft rows never move the balance.
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Reconciliation / lifecycle statuses that must NOT move the book balance. */
const EXCLUDED_STATUSES = ["Void", "Cancelled", "Reversed", "Draft"]

/** Map an account type to its immutable id prefix. */
export function accountPrefixForType(accountType?: string | null): string {
  switch (String(accountType ?? "").trim().toLowerCase()) {
    case "cash":
      return "CASH"
    case "wallet":
      return "WALLET"
    case "upi":
      return "UPI"
    default:
      return "BANK"
  }
}

/**
 * Mint the next per-type Bank & Cash account id (BANK-0001 / CASH-0001 / …).
 * Concurrency-safe and drawn from the shared `record_id_sequences` table, so
 * each type keeps its own independent, gap-free counter.
 */
export function nextFinanceAccountId(accountType?: string | null): Promise<string> {
  return nextRecordId(accountPrefixForType(accountType), { digits: 4, allowCustom: true })
}

/**
 * Net money movement on an account, drawn from its posted-able bank
 * transactions (both the direct legs and the mirror legs of transfers where it
 * is the counter account). Excludes Void / Cancelled / Reversed / Draft rows.
 */
async function netMovementForAccount(financeAccountId: string): Promise<number> {
  const placeholders = EXCLUDED_STATUSES.map(() => "?").join(",")
  const rows = (await query(
    `SELECT
        COALESCE(SUM(CASE WHEN bank_cash_account_id = ? THEN credit ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN bank_cash_account_id = ? THEN debit  ELSE 0 END), 0)
      + COALESCE(SUM(CASE WHEN counter_account_id = ? AND transaction_type = 'Transfer' THEN debit  ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN counter_account_id = ? AND transaction_type = 'Transfer' THEN credit ELSE 0 END), 0)
        AS net
       FROM bank_transactions
      WHERE (bank_cash_account_id = ? OR counter_account_id = ?)
        AND (reconciliation_status IS NULL OR reconciliation_status NOT IN (${placeholders}))`,
    [
      financeAccountId,
      financeAccountId,
      financeAccountId,
      financeAccountId,
      financeAccountId,
      financeAccountId,
      ...EXCLUDED_STATUSES,
    ],
  )) as any[]
  return round2(num(rows?.[0]?.net))
}

export type AccountBalance = { book: number; statement: number; difference: number }

/**
 * Recompute and persist an account's authoritative Book Balance and the
 * reconciliation difference (statement − book). Safe to call as often as
 * needed; it is the single source of truth for the stored balance columns.
 */
export async function recomputeAccountBalance(
  financeAccountId: string | null | undefined,
): Promise<AccountBalance | null> {
  if (!financeAccountId) return null
  const [acct] = (await query(
    `SELECT opening_balance, bank_statement_balance
       FROM finance_accounts WHERE finance_account_id = ? LIMIT 1`,
    [financeAccountId],
  )) as any[]
  if (!acct) return null

  const opening = num(acct.opening_balance)
  const net = await netMovementForAccount(financeAccountId)
  const book = round2(opening + net)
  const statement = num(acct.bank_statement_balance)
  const difference = round2(statement - book)

  await query(
    `UPDATE finance_accounts
        SET current_book_balance = ?, difference = ?
      WHERE finance_account_id = ?`,
    [book, difference, financeAccountId],
  )
  return { book, statement, difference }
}

/**
 * Recompute the balances of every account touched by a bank transaction (its
 * own account and, for a transfer, the counter account). Used by the bank
 * transaction posting side effects so balances stay live after any create /
 * edit / delete without the user ever re-keying them.
 */
export async function recomputeBalancesForBankTxn(txn: Record<string, any>): Promise<void> {
  const ids = new Set<string>()
  if (txn?.bank_cash_account_id) ids.add(String(txn.bank_cash_account_id))
  if (txn?.counter_account_id) ids.add(String(txn.counter_account_id))
  for (const id of ids) {
    try {
      await recomputeAccountBalance(id)
    } catch (error) {
      console.log("[v0] recomputeAccountBalance failed for", id, (error as Error)?.message)
    }
  }
}
