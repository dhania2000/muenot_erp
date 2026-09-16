import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { identifyRelatedPartyTransactions } from "@/lib/finance-related-parties"

// Auto-identified related-party transactions (Phase 8). Scans every existing
// Finance transaction source and matches counterparties back to the declared
// Related Parties master by PAN / GSTIN / name within each relationship's
// effective window. Read-only: it derives disclosure data, it never writes.

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const result = await identifyRelatedPartyTransactions()
  return NextResponse.json(result)
}
