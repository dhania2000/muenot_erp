import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { createBreakGlassRequest, listGrants, TemporaryAccessError } from "@/lib/temporary-access-store"

export const dynamic = "force-dynamic"

/** GET → all break-glass requests for the tenant (active, pending, history). */
export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })
  const grants = await listGrants(tenantId, { kind: "break_glass" })
  return NextResponse.json({ grants, currentUserId: guard.session.userId })
}

/** POST → request emergency (break-glass) access for the signed-in user. */
export async function POST(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    const grant = await createBreakGlassRequest(tenantId, actor, {
      grantedRole: body?.grantedRole ?? null,
      scope: String(body?.scope ?? ""),
      reason: String(body?.reason ?? ""),
      approverName: body?.approverName ?? null,
      durationMinutes: Number(body?.durationMinutes ?? 30),
      notifySecurity: body?.notifySecurity !== false,
    })
    return NextResponse.json({ ok: true, grant })
  } catch (err) {
    if (err instanceof TemporaryAccessError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[admin/security/emergency-access] create failed:", err)
    return NextResponse.json({ error: "Failed to create emergency access request" }, { status: 500 })
  }
}
