import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { getHistory, isGovernedKind } from "@/lib/master-data"
import type { MasterKind } from "@/lib/master-data"

/**
 * SPEC 91 — append-only change history for a single governed value.
 * GET ?kind=&code= → every lifecycle transition and decision, newest first.
 */
export async function GET(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const kindParam = req.nextUrl.searchParams.get("kind")
  const code = req.nextUrl.searchParams.get("code")
  if (!kindParam || !isGovernedKind(kindParam as MasterKind)) {
    return NextResponse.json({ error: "A governed master kind is required." }, { status: 400 })
  }
  if (!code) return NextResponse.json({ error: "A value code is required." }, { status: 400 })

  const history = await getHistory(tenantId, kindParam as MasterKind, code)
  return NextResponse.json({ history })
}
