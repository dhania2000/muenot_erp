import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canCreateInModule } from "@/lib/permission-enforce"
import { getIntegrationOverview, getPostingExceptions } from "@/lib/finance-core-integration"
import { refreshGeneralLedgerFromFinanceMaster } from "@/lib/finance-general-ledger-sync"

export const runtime = "nodejs"

// ---------------------------------------------------------------------------
// SPEC 163 — Finance Core Integration cockpit.
//
// GET  → the live integration map + source-vs-ledger reconciliation across the
//        eight modules (Sales, Purchases, Expenses, Payroll, Banking, Assets,
//        Projects, Tax), plus the current posting exceptions. Read-only, so any
//        authenticated workspace user may view it.
//
// POST → run the shared General Ledger reconciliation (rebuild any ledger rows
//        missing from POSTED journal entries). Reuses the existing engine and
//        the finance.journal create right — it adds NO new accounting logic.
// ---------------------------------------------------------------------------

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const [overview, exceptions] = await Promise.all([getIntegrationOverview(), getPostingExceptions()])
    return NextResponse.json({ ...overview, exceptions })
  } catch (error) {
    const message = (error as Error)?.message || "Could not load the finance integration map."
    console.log("[v0] getIntegrationOverview failed:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  if (!(await canCreateInModule(session, "finance.journal"))) {
    return NextResponse.json({ error: "You do not have permission to reconcile the ledger." }, { status: 403 })
  }

  try {
    const result = await refreshGeneralLedgerFromFinanceMaster()
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    const message = (error as Error)?.message || "Could not reconcile the general ledger."
    console.log("[v0] core-integration reconcile failed:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
