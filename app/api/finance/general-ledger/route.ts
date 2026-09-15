import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getGeneralLedger, type GLFilters, type GLView } from "@/lib/finance-general-ledger"

export const runtime = "nodejs"

const VIEWS: GLView[] = ["ledger", "party", "project", "monthly", "reconciliation", "bank", "integrity"]

// GET /api/finance/general-ledger?view=ledger&financial_year=2026-27&...
//
// Read-only analytical layer over the posted General Ledger. Every view is a
// pure aggregation — no mutation path exists here (the ledger is written only
// by the posting engine when a journal is posted).
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const p = req.nextUrl.searchParams
  const view = (VIEWS.includes(p.get("view") as GLView) ? p.get("view") : "ledger") as GLView

  const filters: GLFilters = {
    search: p.get("search") || undefined,
    financial_year: p.get("financial_year") || undefined,
    month: p.get("month") || undefined,
    quarter: p.get("quarter") || undefined,
    date_from: p.get("date_from") || undefined,
    date_to: p.get("date_to") || undefined,
    account_id: p.get("account_id") || undefined,
    account_group: p.get("account_group") || undefined,
    account_type: p.get("account_type") || undefined,
    transaction_type: p.get("transaction_type") || undefined,
    voucher_type: p.get("voucher_type") || undefined,
    party: p.get("party") || undefined,
    party_type: p.get("party_type") || undefined,
    project: p.get("project") || undefined,
    source_module: p.get("source_module") || undefined,
    reconciliation_status: p.get("reconciliation_status") || undefined,
    side: p.get("side") || undefined,
    balance_type: p.get("balance_type") || undefined,
  }

  try {
    const data = await getGeneralLedger(view, filters, { limit: Number(p.get("limit")) || 500 })
    return NextResponse.json(data)
  } catch (error) {
    console.log("[v0] general-ledger route failed:", (error as Error)?.message)
    return NextResponse.json({ error: "Could not load the General Ledger." }, { status: 500 })
  }
}
