import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { revokeManagedDevice } from "@/lib/managed-device-store"
import { recordAuditLogFromRequest, AUDIT_ACTIONS } from "@/lib/audit-log-store"

/** Revoke a managed device. Tenant-scoped (another tenant's id → 404) and idempotent. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session || session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = getCurrentTenant()?.tenantId ?? null
  if (tenantId == null) return NextResponse.json({ error: "Tenant context required" }, { status: 400 })

  const { id } = await params
  const deviceRowId = Number(id)
  if (!Number.isInteger(deviceRowId) || deviceRowId <= 0) {
    return NextResponse.json({ error: "Invalid device id" }, { status: 400 })
  }

  const ok = await revokeManagedDevice(tenantId, { userId: session.userId, name: session.name }, deviceRowId)
  if (!ok) return NextResponse.json({ error: "Device not found" }, { status: 404 })

  await recordAuditLogFromRequest(request, {
    action: AUDIT_ACTIONS.managedDeviceRevoke,
    result: "success",
    entityType: "managed_device",
    entityId: deviceRowId,
    context: { tenantId, actorUserId: session.userId, actorName: session.name, actorEmail: session.email },
  })
  return NextResponse.json({ revoked: true })
}
