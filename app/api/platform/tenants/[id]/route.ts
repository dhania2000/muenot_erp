import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import {
  setTenantStatus,
  updateTenant,
  deleteTenant,
  type TenantStatus,
  type DeploymentModel,
} from "@/lib/tenant-service"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { HostingModeNotReadyError } from "@/lib/tenant-db/activation"

/**
 * Tenant lifecycle and management. Changing a customer tenant's status, editing
 * its details, or deleting it are high-privilege platform actions (they can
 * lock an entire customer out or destroy their access), so they are restricted
 * to platform super admins and every change is written to the platform audit
 * log as a security-relevant event.
 */
const VALID: TenantStatus[] = ["active", "suspended", "inactive"]
const DEPLOYMENT_MODELS: DeploymentModel[] = ["shared_database", "separate_schema", "dedicated_database"]

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

  // A status-only payload keeps the dedicated lifecycle path (with its
  // platform-owner protection); anything else is treated as a details edit.
  const hasStatus = body?.status !== undefined
  const hasDetails =
    body?.name !== undefined || body?.plan !== undefined || body?.deployment_model !== undefined

  try {
    if (hasStatus && !hasDetails) {
      if (!VALID.includes(body.status)) {
        return NextResponse.json({ error: "Invalid tenant status" }, { status: 400 })
      }
      const tenant = await setTenantStatus(tenantId, body.status)
      await recordPlatformAudit({
        actorUserId: guard.ctx.userId,
        actorEmail: guard.session.email,
        action: "tenant_status_change",
        targetTenantId: tenantId,
        detail: { status: body.status },
      })
      return NextResponse.json({ tenant })
    }

    if (hasDetails) {
      if (body.deployment_model !== undefined && !DEPLOYMENT_MODELS.includes(body.deployment_model)) {
        return NextResponse.json({ error: "Invalid deployment model" }, { status: 400 })
      }
      const tenant = await updateTenant(tenantId, {
        name: body.name,
        plan: body.plan,
        deployment_model: body.deployment_model,
      })
      await recordPlatformAudit({
        actorUserId: guard.ctx.userId,
        actorEmail: guard.session.email,
        action: "tenant_update",
        targetTenantId: tenantId,
        detail: { name: body.name, plan: body.plan, deployment_model: body.deployment_model },
      })
      return NextResponse.json({ tenant })
    }

    return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  } catch (err: any) {
    if (err instanceof HostingModeNotReadyError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    return NextResponse.json({ error: err?.message ?? "Failed to update tenant" }, { status: 400 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const { id } = await params
  const tenantId = Number(id)
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    return NextResponse.json({ error: "Invalid tenant id" }, { status: 400 })
  }

  try {
    const tenant = await deleteTenant(tenantId)
    await recordPlatformAudit({
      actorUserId: guard.ctx.userId,
      actorEmail: guard.session.email,
      action: "tenant_delete",
      targetTenantId: tenantId,
      detail: { name: tenant.name, slug: tenant.slug },
    })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    const status = err?.status ?? 400
    return NextResponse.json({ error: err?.message ?? "Failed to delete tenant" }, { status })
  }
}
