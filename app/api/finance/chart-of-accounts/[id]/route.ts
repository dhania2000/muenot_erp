import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureChartOfAccountsColumns } from "@/lib/finance-ensure"
import { natureForAccountType } from "@/lib/finance-module-configs"
import { getAccountMappings, ACCOUNT_ROLE_GROUPS } from "@/lib/finance-account-config"

// ---------------------------------------------------------------------------
// Chart-of-Accounts account 360° — a single read that assembles an account's
// master record and every linked view the upgraded master exposes:
//
//   • Balance     — opening (master), posted Debit / Credit totals and the live
//                   Current / Closing balance, all derived from the General
//                   Ledger (posted lines only; reversals net out automatically).
//   • Ledger      — the account's own General Ledger lines with running balance.
//   • Journal     — the Journal Entries that reference this account.
//   • Transactions— the source documents (grouped by voucher) that posted here.
//
// This is a pure read. It NEVER mutates the master or the ledger, so it reuses
// the same account_id / account_code linkage every other Finance module relies
// on and adds no parallel accounting store.
// ---------------------------------------------------------------------------

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

async function safeQuery(sql: string, args: any[]): Promise<any[]> {
  try {
    return (await query(sql, args)) as any[]
  } catch (error) {
    console.log("[v0] account-360 query failed:", (error as Error)?.message)
    return []
  }
}

async function loadAccount(id: string) {
  // Accept either the business id (COA-####) or the numeric primary key.
  const isNumeric = /^\d+$/.test(id)
  const rows = await safeQuery(
    `SELECT * FROM chart_of_accounts WHERE ${isNumeric ? "id = ? OR account_id = ?" : "account_id = ?"} LIMIT 1`,
    isNumeric ? [Number(id), id] : [id],
  )
  return rows[0] ?? null
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureChartOfAccountsColumns().catch(() => {})

  const { id } = await ctx.params
  const account = await loadAccount(id)
  if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 })

  const accountId: string = account.account_id

  // Parent account (name + code) for the detail header.
  let parent: { account_id: string; account_name: string; account_code: string | null } | null = null
  if (account.parent_account_id) {
    const [p] = await safeQuery(
      `SELECT account_id, account_name, account_code FROM chart_of_accounts WHERE account_id = ? LIMIT 1`,
      [String(account.parent_account_id)],
    )
    if (p) parent = { account_id: p.account_id, account_name: p.account_name, account_code: p.account_code ?? null }
  }

  // Direct child accounts (one level) so the hierarchy is visible from here.
  const children = await safeQuery(
    `SELECT account_id, account_code, account_name, account_group, nature, active_status
       FROM chart_of_accounts WHERE parent_account_id = ? ORDER BY account_code, account_name`,
    [accountId],
  )

  // Posted Debit / Credit totals straight from the General Ledger.
  const [agg] = await safeQuery(
    `SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c, COUNT(*) n,
            MIN(transaction_date) firstDate, MAX(transaction_date) lastDate
       FROM general_ledger WHERE account_id = ?`,
    [accountId],
  )
  const totalDebit = round2(num(agg?.d))
  const totalCredit = round2(num(agg?.c))
  const net = round2(totalDebit - totalCredit)
  const currentBalance = round2(Math.abs(net))
  const currentSide: "Debit" | "Credit" = net >= 0 ? "Debit" : "Credit"

  const nature = (account.nature as "Debit" | "Credit") || natureForAccountType(account.account_group)
  const opening = round2(num(account.opening_balance))
  const openingSide = (account.opening_balance_type as string) || nature

  const stats = {
    openingBalance: opening,
    openingSide,
    totalDebit,
    totalCredit,
    net,
    currentBalance,
    currentSide,
    // The opening balance is itself posted into the General Ledger, so the live
    // current balance already includes it — closing == current by construction.
    closingBalance: currentBalance,
    closingSide: currentSide,
    entryCount: num(agg?.n),
    firstDate: agg?.firstDate ?? null,
    lastDate: agg?.lastDate ?? null,
    nature,
  }

  // Ledger lines — chronological so the stored running balance reads top-down.
  const ledger = await safeQuery(
    `SELECT id, ledger_id, transaction_date, value_date, voucher_no, voucher_type,
            transaction_type, reference_no, party_name, project_name, description,
            debit, credit, balance, balance_type, source_module, source_reference,
            journal_entry_id, reconciliation_status
       FROM general_ledger
      WHERE account_id = ?
      ORDER BY transaction_date ASC, id ASC
      LIMIT 500`,
    [accountId],
  )

  // Journal entries that touch this account (newest first).
  const journal = await safeQuery(
    `SELECT id, journal_entry_id, voucher_no, journal_date, voucher_type, reference_type,
            reference_no, narration, party_name, project_name, debit, credit, net_amount,
            gst_amount, tds_amount, source_module, approval_status, posting_status
       FROM journal_entries
      WHERE account_id = ?
      ORDER BY journal_date DESC, id DESC
      LIMIT 500`,
    [accountId],
  )

  // Source transactions — one row per posting voucher that hit this account,
  // rolled up so the user sees the originating document, not each ledger leg.
  const transactions = await safeQuery(
    `SELECT voucher_no,
            COALESCE(NULLIF(source_module,''), voucher_type, 'Manual') AS source_module,
            source_reference,
            voucher_type,
            MIN(transaction_date) AS date,
            COALESCE(SUM(debit),0) AS debit,
            COALESCE(SUM(credit),0) AS credit,
            COUNT(*) AS lines
       FROM general_ledger
      WHERE account_id = ?
      GROUP BY voucher_no, source_module, source_reference, voucher_type
      ORDER BY date DESC, voucher_no DESC
      LIMIT 300`,
    [accountId],
  )

  // Posting roles this head currently serves (Default Bank, Output CGST, TDS
  // Payable, …). Inverted from the SAME role → account mapping the posting
  // engine resolves, so the detail view shows exactly what this account is
  // wired to — never a parallel guess. Failure-tolerant: a mapping read error
  // simply yields no role tags rather than blocking the 360 view.
  let roles: { role: string; label: string; overridden: boolean }[] = []
  try {
    const labelByRole = new Map<string, string>()
    for (const g of ACCOUNT_ROLE_GROUPS) for (const r of g.roles) labelByRole.set(r.role, r.label)
    const mappings = await getAccountMappings()
    roles = mappings
      .filter((m) => m.effective_account_id && String(m.effective_account_id) === accountId)
      .map((m) => ({ role: m.role, label: labelByRole.get(m.role) ?? m.role, overridden: m.overridden }))
  } catch (error) {
    console.log("[v0] account-360 role mapping failed:", (error as Error)?.message)
  }

  return NextResponse.json({ account, parent, children, stats, ledger, journal, transactions, roles })
}
