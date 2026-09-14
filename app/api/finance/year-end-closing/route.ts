import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  listClosings,
  getClosingStatus,
  closeYear,
  reopenYear,
} from "@/lib/finance-year-end-closing"
import { listLedgerFinancialYears } from "@/lib/finance-statements"

/**
 * Year-end closing facility.
 *
 *   GET  ?fy=2026-27   → live status + preview of one FY (net result to close)
 *   GET                → all recorded closings + financial years in the ledger
 *   POST { financial_year, action: "close" | "reopen" }
 *
 * Posting runs through the shared Journal + General Ledger pipeline; this route
 * only orchestrates it and never mutates the ledger directly.
 */
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const fy = req.nextUrl.searchParams.get("fy")
  const financialYears = await listLedgerFinancialYears()

  if (fy) {
    const status = await getClosingStatus(fy, { preview: true })
    return NextResponse.json({ status, financialYears })
  }

  const closings = await listClosings()
  return NextResponse.json({ closings, financialYears })
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const fy = String(body.financial_year ?? "").trim()
  const action = String(body.action ?? "").trim()
  if (!fy) return NextResponse.json({ error: "financial_year is required." }, { status: 400 })

  if (action === "close") {
    const result = await closeYear(fy, { createdBy: session.userId })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
    return NextResponse.json({ ok: true, status: result.status })
  }
  if (action === "reopen") {
    const result = await reopenYear(fy, { createdBy: session.userId })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
    return NextResponse.json({ ok: true })
  }
  return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 })
}
