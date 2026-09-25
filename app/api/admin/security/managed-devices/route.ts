import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import {
  enrollManagedDevice,
  getManagedDevicePolicy,
  listManagedDevices,
  upsertManagedDevicePolicy,
} from "@/lib/managed-device-store"
import { resolveTenantIdForUser } from "@/lib/tenant-service"
import { recordAuditLogFromRequest, AUDIT_ACTIONS } from "@/lib/audit-log-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  return { session, tenantId: tenant?.tenantId ?? null }
}

function auditContext(ctx: NonNullable<Awaited<ReturnType<typeof requireAdminTenant>>>) {
  return {
    tenantId: ctx.tenantId,
    actorUserId: ctx.session.userId,
    actorName: ctx.session.name,
    actorEmail: ctx.session.email,
  }
}

export async function GET() {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const [policy, devices] = await Promise.all([
    getManagedDevicePolicy(ctx.tenantId),
    listManagedDevices(ctx.tenantId),
  ])
  return NextResponse.json({ policy, devices })
}

/** Update the tenant managed-device policy (idempotent upsert). */
export async function PUT(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (ctx.tenantId == null) return NextResponse.json({ error: "Tenant context required" }, { status: 400 })
  const body = (await request.json().catch(() => null)) as { required?: unknown; emergencyAccess?: unknown } | null
  if (!body || typeof body.required !== "boolean") {
    return NextResponse.json({ error: "`required` must be a boolean" }, { status: 400 })
  }
  if (body.emergencyAccess !== undefined && typeof body.emergencyAccess !== "boolean") {
    return NextResponse.json({ error: "`emergencyAccess` must be a boolean" }, { status: 400 })
  }
  const before = await getManagedDevicePolicy(ctx.tenantId)
  const policy = await upsertManagedDevicePolicy(ctx.tenantId, { userId: ctx.session.userId, name: ctx.session.name }, body)
  await recordAuditLogFromRequest(request, {
    action: AUDIT_ACTIONS.managedDevicePolicyUpdate,
    result: "success",
    entityType: "managed_device_policy",
    entityId: ctx.tenantId,
    entityLabel: "Managed-device policy",
    before: { required: before.required, emergencyAccess: before.emergencyAccess },
    after: { required: policy.required, emergencyAccess: policy.emergencyAccess },
    context: auditContext(ctx),
  })
  return NextResponse.json({ policy })
}

/**
 * Enroll a device and issue its verified device assertion (returned once).
 * Honours `Idempotency-Key` so a retried request never double-enrolls.
 */
export async function POST(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (ctx.tenantId == null) return NextResponse.json({ error: "Tenant context required" }, { status: 400 })

  const body = (await request.json().catch(() => null)) as { userId?: unknown; label?: unknown } | null
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  if (body.label !== undefined && (typeof body.label !== "string" || body.label.length > 190)) {
    return NextResponse.json({ error: "`label` must be a string of at most 190 characters" }, { status: 400 })
  }
  let targetUserId = ctx.session.userId
  if (body.userId !== undefined) {
    const n = Number(body.userId)
    if (!Number.isInteger(n) || n <= 0) return NextResponse.json({ error: "`userId` must be a positive integer" }, { status: 400 })
    targetUserId = n
  }

  // Cross-tenant guard: the device owner must belong to the caller's tenant.
  const ownerTenant = await resolveTenantIdForUser(targetUserId)
  if (ownerTenant !== ctx.tenantId) {
    return NextResponse.json({ error: "User not found" }, { status: 404 })
  }

  const idempotencyKey = request.headers.get("idempotency-key")
  try {
    const result = await enrollManagedDevice(
      ctx.tenantId,
      { userId: ctx.session.userId, name: ctx.session.name },
      { userId: targetUserId, label: body.label, idempotencyKey },
    )
    if (!result.replayed) {
      await recordAuditLogFromRequest(request, {
        action: AUDIT_ACTIONS.managedDeviceEnroll,
        result: "success",
        entityType: "managed_device",
        entityId: result.device.id,
        entityLabel: result.device.label,
        after: { deviceId: result.device.deviceId, userId: targetUserId },
        context: auditContext(ctx),
      })
    }
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 })
  }
}
