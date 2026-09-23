import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { createTemporaryGrant, listGrants, TemporaryAccessError } from "@/lib/temporary-access-store"

export const dynamic = "force-dynamic"

/** GET → all temporary access grants for the tenant (active, scheduled, history). */
export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })
  const grants = await listGrants(tenantId, { kind: "temporary" })
  return NextResponse.json({ grants })
}

/** POST → create (and immediately or on schedule activate) a temporary grant. */
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

  const userId = Number(body?.userId)
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "A valid user is required" }, { status: 400 })
  }
  const startAt = body?.startAt ? new Date(String(body.startAt)) : new Date()
  const expiresAt = new Date(String(body?.expiresAt ?? ""))
  if (Number.isNaN(expiresAt.getTime())) {
    return NextResponse.json({ error: "A valid expiry time is required" }, { status: 400 })
  }

  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    const grant = await createTemporaryGrant(tenantId, actor, {
      userId,
      grantedRole: body?.grantedRole ?? null,
      scope: String(body?.scope ?? ""),
      reason: String(body?.reason ?? ""),
      approverName: body?.approverName ?? null,
      startAt: Number.isNaN(startAt.getTime()) ? new Date() : startAt,
      expiresAt,
    })
    return NextResponse.json({ ok: true, grant })
  } catch (err) {
    if (err instanceof TemporaryAccessError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[admin/security/temporary-access] create failed:", err)
    return NextResponse.json({ error: "Failed to create temporary access grant" }, { status: 500 })
  }
}
