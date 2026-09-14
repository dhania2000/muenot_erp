import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { getDeductorIdentity } from "@/lib/finance-tds-compliance"
import { listTdsRules } from "@/lib/finance-tds-rules"

const FEATURE = "finance.tds_filing"

// Read-only reference data for the TDS compliance workspace: the deductor's
// statutory identity (TAN / PAN / legal name) and the TDS Rule Master. Both are
// already the single source of truth used server-side by the filing engine —
// this route simply surfaces them to the UI so the module can show the deductor
// banner and the maintained rate/threshold table without any new state.
export async function GET() {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const [deductor, rules] = await Promise.all([getDeductorIdentity(), listTdsRules()])
    return NextResponse.json({ deductor, rules })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
