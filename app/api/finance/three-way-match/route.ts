import { NextRequest, NextResponse } from "next/server"
import { requireModuleAction, getTenantId } from "@/lib/api-auth"
import { getMatchTolerances, listMatches } from "@/lib/finance-three-way-match-server"

export const runtime = "nodejs"

// GET /api/finance/three-way-match?status=exception&resolution=open&holdOnly=1
//   → the tenant's persisted PO ⇄ GRN ⇄ bill match ledger (read-only), plus the
//     active tolerance configuration and hold/exception counts. Tenant scope is
//     derived from the verified session — never from request input.
export async function GET(req: NextRequest) {
  const session = await requireModuleAction("finance.purchase_bills", "view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = await getTenantId()
  if (tenantId == null) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const status = sp.get("status") || undefined
  const resolution = sp.get("resolution") || undefined
  const holdOnly = sp.get("holdOnly") === "1" || sp.get("holdOnly") === "true"

  const [matches, tolerances] = await Promise.all([
    listMatches(tenantId, { status, resolution, holdOnly }),
    getMatchTolerances(tenantId),
  ])

  const summary = {
    total: matches.length,
    onHold: matches.filter((m) => m.paymentHold).length,
    openExceptions: matches.filter((m) => m.status === "exception" && m.resolutionStatus === "open").length,
  }

  return NextResponse.json({ matches, tolerances, summary })
}
