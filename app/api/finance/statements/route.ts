import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  computeTrialBalance,
  computeProfitAndLoss,
  computeBalanceSheet,
  computeCashFlow,
  listLedgerFinancialYears,
  fyRange,
} from "@/lib/finance-statements"

/**
 * Read-only financial statements derived from the Chart of Accounts
 * classification + the General Ledger. Never writes; it only aggregates the
 * same ledger every other Finance module posts to.
 *
 *   GET /api/finance/statements?type=trial-balance|profit-loss|balance-sheet|cash-flow
 *       &fy=2026-27            (optional — expands to the FY date range)
 *       &from=YYYY-MM-DD&to=YYYY-MM-DD  (optional explicit range; overrides fy)
 *
 * With no `type`, returns the list of financial years available for pickers.
 */
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const type = sp.get("type")

  const financialYears = await listLedgerFinancialYears()

  if (!type) {
    return NextResponse.json({ financialYears })
  }

  const fy = sp.get("fy")
  let from = sp.get("from")
  let to = sp.get("to")
  if (fy) {
    const range = fyRange(fy)
    if (range) {
      from = from || range.from
      to = to || range.to
    }
  }

  try {
    switch (type) {
      case "trial-balance": {
        const data = await computeTrialBalance(to)
        return NextResponse.json({ type, fy, data, financialYears })
      }
      case "profit-loss": {
        const data = await computeProfitAndLoss(from, to)
        return NextResponse.json({ type, fy, data, financialYears })
      }
      case "balance-sheet": {
        const data = await computeBalanceSheet(to)
        return NextResponse.json({ type, fy, data, financialYears })
      }
      case "cash-flow": {
        const data = await computeCashFlow(from, to)
        return NextResponse.json({ type, fy, data, financialYears })
      }
      default:
        return NextResponse.json({ error: `Unknown statement type "${type}".` }, { status: 400 })
    }
  } catch (error) {
    console.log("[v0] statements error:", (error as Error)?.message)
    return NextResponse.json({ error: "Failed to generate statement." }, { status: 500 })
  }
}
