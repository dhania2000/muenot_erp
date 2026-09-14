import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { getFinanceEvents } from "@/lib/finance-audit"
import { recomputeAccountBalance } from "@/lib/finance-account-master"

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

async function loadAccount(id: string) {
  // Accept either the business id (ACC-####) or the numeric pk.
  const isNumeric = /^\d+$/.test(id)
  const rows = (await query(
    `SELECT * FROM finance_accounts WHERE ${isNumeric ? "id = ? OR finance_account_id = ?" : "finance_account_id = ?"} LIMIT 1`,
    isNumeric ? [Number(id), id] : [id],
  )) as any[]
  return rows[0] ?? null
}

/**
 * Bank & Cash account 360 — a single read that assembles the account master
 * (with its balance refreshed server-side from stored transactions), the recent
 * transaction ledger, reconciliation + cash-flow rollups, and the audit trail.
 * All money is derived on the server so the browser never recomputes it.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await ctx.params
  const existing = await loadAccount(id)
  if (!existing) return NextResponse.json({ error: "Account not found" }, { status: 404 })

  const accountId: string = existing.finance_account_id

  // Refresh the authoritative book balance/difference before reading it back so
  // the detail view always reflects the latest posted transactions.
  await recomputeAccountBalance(accountId)
  const account = await loadAccount(accountId)

  // Transactions that touch this account, either as the account itself or as the
  // counter (transfer) account. Newest first, capped for the ledger view.
  const transactions = (await query(
    `SELECT id, transaction_id, transaction_date, value_date, transaction_type,
            voucher_type, reference_no, cheque_utr_reference, party_id, party_name,
            account_head, project_name, debit, credit, amount, payment_mode,
            narration, reconciliation_status, reconciliation_date, journal_entry_id
       FROM bank_transactions
      WHERE bank_cash_account_id = ?
      ORDER BY transaction_date DESC, id DESC
      LIMIT 200`,
    [accountId],
  )) as any[]

  // ---- Cash-flow + reconciliation rollup (full history, not just the page) --
  const [flow] = (await query(
    `SELECT
        COUNT(*) AS txnCount,
        COALESCE(SUM(credit),0) AS totalCredit,
        COALESCE(SUM(debit),0) AS totalDebit,
        SUM(CASE WHEN reconciliation_status = 'Reconciled' THEN 1 ELSE 0 END) AS reconciledCount,
        SUM(CASE WHEN reconciliation_status = 'Reconciled' THEN (credit + debit) ELSE 0 END) AS reconciledAmount,
        SUM(CASE WHEN COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') NOT IN ('Reconciled','Excluded') THEN 1 ELSE 0 END) AS unreconciledCount,
        SUM(CASE WHEN COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') NOT IN ('Reconciled','Excluded') THEN (credit + debit) ELSE 0 END) AS unreconciledAmount,
        MAX(transaction_date) AS lastTransactionDate
       FROM bank_transactions
      WHERE bank_cash_account_id = ?`,
    [accountId],
  )) as any[]

  const stats = {
    txnCount: num(flow?.txnCount),
    totalCredit: round2(num(flow?.totalCredit)),
    totalDebit: round2(num(flow?.totalDebit)),
    netMovement: round2(num(flow?.totalCredit) - num(flow?.totalDebit)),
    reconciledCount: num(flow?.reconciledCount),
    reconciledAmount: round2(num(flow?.reconciledAmount)),
    unreconciledCount: num(flow?.unreconciledCount),
    unreconciledAmount: round2(num(flow?.unreconciledAmount)),
    reconciledPct:
      num(flow?.txnCount) > 0 ? Math.round((num(flow?.reconciledCount) / num(flow?.txnCount)) * 100) : 0,
    lastTransactionDate: flow?.lastTransactionDate ?? null,
    openingBalance: round2(num(account.opening_balance)),
    bookBalance: round2(num(account.current_book_balance)),
    statementBalance: round2(num(account.bank_statement_balance)),
    difference: round2(num(account.difference)),
    reconciled: Math.abs(num(account.difference)) < 0.01,
  }

  const audit = account.id ? await getFinanceEvents("finance_account", Number(account.id)) : []

  return NextResponse.json({ account, transactions, stats, audit })
}
