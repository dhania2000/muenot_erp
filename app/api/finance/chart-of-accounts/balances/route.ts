import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentBalances } from "@/lib/finance-account-balances"

// Read-only: the live current balance of every account, derived purely from the
// General Ledger. Never mutates the master or the ledger.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const map = await getCurrentBalances()
  const balances: Record<string, { net: number; balance: number; balance_type: string }> = {}
  for (const [accountId, b] of map) {
    balances[accountId] = { net: b.net, balance: b.balance, balance_type: b.balance_type }
  }
  return NextResponse.json({ balances })
}
