import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { AccessReviewError, recordDecision } from "@/lib/access-review-store"

export const dynamic = "force-dynamic"

const DECISIONS = new Set(["approved", "revoked", "remediated"])

/** POST → record an approve / revoke / remediate decision on a single item. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const itemId = Number((await params).itemId)
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ error: "Invalid item id" }, { status: 400 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (!DECISIONS.has(body?.decision)) {
    return NextResponse.json({ error: "decision must be approved, revoked, or remediated" }, { status: 400 })
  }

  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    const item = await recordDecision(tenantId, actor, itemId, body.decision, {
      note: body?.note ?? null,
      remediation: body?.remediation ?? null,
    })
    return NextResponse.json({ ok: true, item })
  } catch (err) {
    if (err instanceof AccessReviewError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[admin/security/access-reviews] decision failed:", err)
    return NextResponse.json({ error: "Failed to record decision" }, { status: 500 })
  }
}
