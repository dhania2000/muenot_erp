import { NextRequest, NextResponse } from "next/server"
import { requireModuleAction, getTenantId } from "@/lib/api-auth"
import { getMatchForBill, listMatchEvents } from "@/lib/finance-three-way-match-server"

export const runtime = "nodejs"

// GET /api/finance/three-way-match/:billId
//   → one bill's full match evidence (the variance breakdown a checker sees to
//     hold or release payment) plus its audit trail (every compute + override).
//     Scoped to the caller's tenant: a bill from another tenant returns 404.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ billId: string }> }) {
  const session = await requireModuleAction("finance.purchase_bills", "view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = await getTenantId()
  if (tenantId == null) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { billId } = await params
  const match = await getMatchForBill(tenantId, billId)
  if (!match) return NextResponse.json({ error: "No three-way match record exists for this bill." }, { status: 404 })

  const events = await listMatchEvents(tenantId, billId)
  return NextResponse.json({ match, events })
}
