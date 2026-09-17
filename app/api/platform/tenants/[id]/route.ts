import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { setTenantStatus, type TenantStatus } from "@/lib/tenant-service"
import { recordPlatformAudit } from "@/lib/platform-roles"

/**
 * SPEC 4 — Tenant lifecycle. Suspending / reactivating / deactivating a
 * customer tenant is a high-privilege platform action (it can lock an entire
 * customer out), so it is restricted to platform super admins and every change
 * is written to the platform audit log as a security-relevant event.
 */
const VALID: TenantStatus[] = ["active", "suspended", "inactive"]

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const { id } = await params
  const tenantId = Number(id)
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    return NextResponse.json({ error: "Invalid tenant id" }, { status: 400 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const status = body?.status
  if (!VALID.includes(status)) {
    return NextResponse.json({ error: "Invalid tenant status" }, { status: 400 })
  }

  try {
    const tenant = await setTenantStatus(tenantId, status)
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "tenant_status_change",
      targetTenantId: tenantId,
      detail: { status },
    })
    return NextResponse.json({ tenant })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to update tenant" }, { status: 400 })
  }
}
