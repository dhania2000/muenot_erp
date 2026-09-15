import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canCreateInModule } from "@/lib/permission-enforce"
import { refreshGeneralLedgerFromFinanceMaster } from "@/lib/finance-general-ledger-sync"

export const runtime = "nodejs"

// ---------------------------------------------------------------------------
// Phase 35 — General Ledger reconciliation endpoint.
//
// POST rebuilds any missing ledger rows from the POSTED Journal Entries (the
// primary accounting source). It is idempotent: rows that already exist are
// skipped, so it is safe to press repeatedly. Reuses the Journal & Ledger
// permission — a user who can create journal postings can trigger the sync.
// ---------------------------------------------------------------------------
export async function POST() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  if (!(await canCreateInModule(session, "finance.journal"))) {
    return NextResponse.json({ error: "You do not have permission to sync the general ledger." }, { status: 403 })
  }

  try {
    const result = await refreshGeneralLedgerFromFinanceMaster()
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    const message = (error as Error)?.message || "Could not sync the general ledger."
    console.log("[v0] refreshGeneralLedgerFromFinanceMaster failed:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
