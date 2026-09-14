import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensureChartOfAccountsColumns } from "@/lib/finance-ensure"
import {
  listOpeningBalances,
  saveOpeningBalances,
  type OpeningBalanceInput,
} from "@/lib/finance-opening-balance"

// ---------------------------------------------------------------------------
// Per-financial-year opening balances for one Chart-of-Accounts head.
//
// GET  → every stored year's opening balance (amount, side, date, voucher).
// PUT  → replace the set of years; each is projected into its own balanced
//        Journal + General Ledger voucher via saveOpeningBalances (never a bare
//        number). This reuses the SINGLE accounting system — no parallel ledger
//        and no new account key; the head is still resolved by account_id.
// ---------------------------------------------------------------------------

async function loadAccount(id: string) {
  const isNumeric = /^\d+$/.test(id)
  const rows = (await query(
    `SELECT id, account_id, account_name, account_code, account_group, nature, active_status, financial_year, is_system
       FROM chart_of_accounts WHERE ${isNumeric ? "id = ? OR account_id = ?" : "account_id = ?"} LIMIT 1`,
    isNumeric ? [Number(id), id] : [id],
  )) as any[]
  return rows[0] ?? null
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureChartOfAccountsColumns().catch(() => {})

  const { id } = await ctx.params
  const account = await loadAccount(id)
  if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 })

  const years = await listOpeningBalances(String(account.account_id))
  return NextResponse.json({
    account: {
      account_id: account.account_id,
      account_name: account.account_name,
      account_code: account.account_code ?? null,
      account_group: account.account_group,
      nature: account.nature,
      active_status: account.active_status ?? "Active",
      financial_year: account.financial_year ?? null,
    },
    years,
  })
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  await ensureChartOfAccountsColumns().catch(() => {})

  const { id } = await ctx.params
  const account = await loadAccount(id)
  if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const raw = Array.isArray(body?.years) ? body.years : []
  const entries: OpeningBalanceInput[] = raw.map((r: any) => ({
    financial_year: String(r?.financial_year ?? "").trim(),
    opening_balance: Number(r?.opening_balance ?? 0),
    opening_balance_date: r?.opening_balance_date ? String(r.opening_balance_date).slice(0, 10) : null,
  }))

  const result = await saveOpeningBalances(String(account.account_id), entries, { createdBy: session.userId })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  const years = await listOpeningBalances(String(account.account_id))
  return NextResponse.json({ ok: true, years })
}
