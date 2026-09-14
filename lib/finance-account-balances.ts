import "server-only"
import { query } from "@/lib/db"

// ---------------------------------------------------------------------------
// Current balance from the General Ledger (server-only, read-only).
//
// An account's *current* balance is never stored on chart_of_accounts and never
// entered by hand — it is the live net movement of every posted General Ledger
// line for that account. Because the opening-balance voucher is itself a real
// GL posting (lib/finance-opening-balance.ts), the GL already includes opening
// balances, so:
//
//   current signed balance = Σ debit − Σ credit           (across all GL rows)
//   presented balance       = |signed| on its natural side (Debit/Credit label)
//
// Reversals post equal-and-opposite GL rows, so summing every row nets them out
// automatically — no status filtering needed. This is a pure read that never
// mutates the ledger or the master; the stored opening balance is untouched.
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

export type CurrentBalance = {
  account_id: string
  /** Net debit − credit. Positive = net debit movement, negative = net credit. */
  net: number
  /** Absolute value, for display. */
  balance: number
  /** Side the balance sits on given the net movement. */
  balance_type: "Debit" | "Credit"
}

/**
 * Compute the current GL balance for every account in one grouped query.
 * Returns a map keyed by account_id; accounts with no postings are simply
 * absent (the caller treats a miss as a zero balance).
 */
export async function getCurrentBalances(): Promise<Map<string, CurrentBalance>> {
  const out = new Map<string, CurrentBalance>()
  let rows: any[] = []
  try {
    rows = (await query(
      `SELECT account_id,
              COALESCE(SUM(debit), 0)  AS d,
              COALESCE(SUM(credit), 0) AS c
         FROM general_ledger
        WHERE account_id IS NOT NULL AND account_id <> ''
        GROUP BY account_id`,
    )) as any[]
  } catch (error) {
    // A missing general_ledger table in a bare environment just means no
    // postings yet — return empty rather than breaking the Chart of Accounts.
    console.log("[v0] getCurrentBalances failed:", (error as Error)?.message)
    return out
  }
  for (const r of rows) {
    const net = round2(Number(r.d) - Number(r.c))
    out.set(String(r.account_id), {
      account_id: String(r.account_id),
      net,
      balance: round2(Math.abs(net)),
      balance_type: net >= 0 ? "Debit" : "Credit",
    })
  }
  return out
}
