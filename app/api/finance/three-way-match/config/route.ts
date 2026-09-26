import { NextRequest, NextResponse } from "next/server"
import { requireModuleAction, getTenantId } from "@/lib/api-auth"
import { validateTolerancePayload } from "@/lib/finance-three-way-match"
import { getMatchTolerances, setMatchTolerances } from "@/lib/finance-three-way-match-server"

export const runtime = "nodejs"

// GET /api/finance/three-way-match/config → the tenant's match tolerances.
export async function GET() {
  const session = await requireModuleAction("finance.purchase_bills", "view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = await getTenantId()
  if (tenantId == null) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json({ tolerances: await getMatchTolerances(tenantId) })
}

// PUT /api/finance/three-way-match/config
//   { quantityPercent, pricePercent, amountPercent, amountAbsolute }
//   Strictly validated (out-of-range values are rejected, not clamped) so an
//   admin never silently saves a different number. The change is audited.
export async function PUT(req: NextRequest) {
  const session = await requireModuleAction("finance.purchase_bills", "update")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = await getTenantId()
  if (tenantId == null) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const parsed = validateTolerancePayload(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const tolerances = await setMatchTolerances(tenantId, parsed.value, session.userId, session.name ?? null)
  return NextResponse.json({ tolerances })
}
