import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { monthEndReport, errorCenter, reconciliationSummary } from "@/lib/finance-journal-control"
import { runJournalChecks } from "@/lib/finance-journal-automation"

export const runtime = "nodejs"

/**
 * Journal Control Center data (Phases 54, 55, 58, 60).
 * GET /api/finance/journal-entries/control?period=YYYY-MM
 *
 * Returns, for the requested period (defaults to the current month), the
 * month-end checklist, the error center, the reconciliation summary and the
 * automation check snapshot — all read-only projections over the existing
 * accounting tables.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(request.url)
  const now = new Date()
  const period = url.searchParams.get("period") || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`

  try {
    const [monthEnd, errors, reconciliation, checks] = await Promise.all([
      monthEndReport(period),
      errorCenter(period),
      reconciliationSummary(period),
      runJournalChecks(period),
    ])
    return NextResponse.json({ period, monthEnd, errors, reconciliation, checks })
  } catch (error) {
    console.log("[v0] journal control failed:", (error as Error)?.message)
    return NextResponse.json({ error: "Failed to load control center" }, { status: 500 })
  }
}
