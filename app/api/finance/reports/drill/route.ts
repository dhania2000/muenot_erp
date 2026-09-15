import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { query } from "@/lib/db"

// Report drill-down (Report → Account → Ledger). Given an account name (and an
// optional date range matching the report's period), returns the posted
// general_ledger movement for that account. Each line carries its voucher_no so
// the client can hand off to the existing LedgerTraceDrawer, which continues the
// chain Ledger → Journal → Source. Read-only projection over general_ledger;
// defensive so a missing table yields an empty result rather than a 500.

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export async function GET(req: NextRequest) {
  const session = await requireFeature("finance.financial_reports")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const account = (sp.get("account") || "").trim()
  const group = (sp.get("group") || "").trim()
  if (!account && !group) {
    return NextResponse.json({ error: "An account or group is required" }, { status: 400 })
  }

  const from = (sp.get("from") || "").trim()
  const to = (sp.get("to") || "").trim()

  const where: string[] = []
  const args: any[] = []
  if (account) {
    where.push("account_name = ?")
    args.push(account)
  }
  if (group) {
    where.push("account_group = ?")
    args.push(group)
  }
  if (from) {
    where.push("transaction_date >= ?")
    args.push(from)
  }
  if (to) {
    where.push("transaction_date <= ?")
    args.push(to)
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""

  let rows: any[] = []
  let available = true
  try {
    rows = (await query(
      `SELECT ledger_id, voucher_no, transaction_date, account_name, account_group,
              COALESCE(NULLIF(narration,''),'—') AS narration,
              COALESCE(debit,0) AS debit,
              COALESCE(credit,0) AS credit,
              COALESCE(balance,0) AS balance,
              COALESCE(NULLIF(balance_type,''),'') AS balance_type,
              COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') AS reconciliation_status
         FROM general_ledger
         ${clause}
         ORDER BY transaction_date ASC, id ASC
         LIMIT 1000`,
      args,
    )) as any[]
  } catch (err) {
    console.log("[v0] report drill query failed", (err as Error).message)
    available = false
    rows = []
  }

  const lines = rows.map((r) => ({
    ledgerId: String(r.ledger_id ?? ""),
    voucherNo: r.voucher_no ? String(r.voucher_no) : "",
    date: String(r.transaction_date || "").slice(0, 10),
    account: String(r.account_name || ""),
    group: String(r.account_group || ""),
    narration: String(r.narration || ""),
    debit: num(r.debit),
    credit: num(r.credit),
    balance: num(r.balance),
    balanceType: String(r.balance_type || ""),
    reconciliation: String(r.reconciliation_status || "Unreconciled"),
  }))

  const totals = {
    debit: lines.reduce((s, l) => s + l.debit, 0),
    credit: lines.reduce((s, l) => s + l.credit, 0),
  }

  return NextResponse.json({
    account: account || null,
    group: group || null,
    available,
    lines,
    totals,
  })
}
