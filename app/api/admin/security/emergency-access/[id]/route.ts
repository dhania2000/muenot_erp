import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { approveGrant, rejectGrant, revokeGrant, TemporaryAccessError } from "@/lib/temporary-access-store"

export const dynamic = "force-dynamic"

function parseId(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * PATCH → run one action on a break-glass request:
 *   approve → activate the elevation (requires a DIFFERENT admin),
 *   reject  → decline a pending request,
 *   revoke  → end an active grant early.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const { id } = await params
  const grantId = parseId(id)
  if (grantId == null) return NextResponse.json({ error: "Invalid grant id" }, { status: 400 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  const action = String(body?.action ?? "")

  try {
    switch (action) {
      case "approve": {
        const grant = await approveGrant(tenantId, grantId, actor)
        return NextResponse.json({ ok: true, grant })
      }
      case "reject": {
        const grant = await rejectGrant(tenantId, grantId, actor, String(body?.reason ?? ""))
        return NextResponse.json({ ok: true, grant })
      }
      case "revoke": {
        const grant = await revokeGrant(tenantId, grantId, actor, String(body?.reason ?? ""))
        return NextResponse.json({ ok: true, grant })
      }
      default:
        return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 })
    }
  } catch (err) {
    if (err instanceof TemporaryAccessError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[admin/security/emergency-access] action failed:", action, err)
    return NextResponse.json({ error: "Failed to complete the requested action" }, { status: 500 })
  }
}
