import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { revokeGrant, TemporaryAccessError } from "@/lib/temporary-access-store"

export const dynamic = "force-dynamic"

function parseId(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** PATCH → revoke a temporary grant early (reverts elevation & access window). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const { id } = await params
  const grantId = parseId(id)
  if (grantId == null) return NextResponse.json({ error: "Invalid grant id" }, { status: 400 })

  let body: any = {}
  try {
    body = await req.json()
  } catch {
    // Reason is optional on revoke.
  }

  const actor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    const grant = await revokeGrant(tenantId, grantId, actor, String(body?.reason ?? ""))
    return NextResponse.json({ ok: true, grant })
  } catch (err) {
    if (err instanceof TemporaryAccessError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error("[admin/security/temporary-access] revoke failed:", err)
    return NextResponse.json({ error: "Failed to revoke temporary access grant" }, { status: 500 })
  }
}
