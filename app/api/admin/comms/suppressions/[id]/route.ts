import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { releaseSuppression } from "@/lib/comms-governance/service"
import { GovernanceError } from "@/lib/comms-governance/model"

/**
 * Spec41 — release (lift) a suppression. Tenant-admin only and tenant-scoped: a
 * foreign id resolves to "not found" (cross-tenant IDOR defense). A consent
 * withdrawal (complaint / opt_out) is locked and can never be lifted by an admin.
 */

function statusFor(code: string): number {
  if (code === "not_found") return 404
  if (code === "consent_locked") return 409
  return 400
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)!
  const { id } = await params
  try {
    await releaseSuppression(tenantId, guard.session.userId, Number(id))
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof GovernanceError) return NextResponse.json({ error: err.message, code: err.code }, { status: statusFor(err.code) })
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
