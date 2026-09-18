import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getConsolidatedReport } from "@/lib/legal-entities"

/**
 * SPEC 7 — entity-level + consolidated reporting.
 * Rolls up the posted General Ledger per entity and returns a consolidated
 * total with inter-company movements eliminated. Optional financial_year /
 * date_from / date_to filters narrow the window.
 */
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const report = await getConsolidatedReport({
    financial_year: searchParams.get("financial_year") || undefined,
    date_from: searchParams.get("date_from") || undefined,
    date_to: searchParams.get("date_to") || undefined,
  })
  return NextResponse.json({ report })
}
