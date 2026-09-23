import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { deleteAccessPolicy, updateAccessPolicy, type AccessPolicyInput } from "@/lib/access-policy-store"
import { recordSecurityEvent } from "@/lib/security-audit-store"
import { recordAuditLogFromRequest, AUDIT_ACTIONS } from "@/lib/audit-log-store"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  return { session, tenantId: tenant?.tenantId ?? null }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as AccessPolicyInput
  try {
    const policy = await updateAccessPolicy(ctx.tenantId, Number(id), body)
    if (!policy) return NextResponse.json({ error: "Policy not found" }, { status: 404 })
    await recordSecurityEvent({
      tenantId: ctx.tenantId,
      category: "access_policy",
      action: "policy_updated",
      outcome: "updated",
      actorUserId: ctx.session.userId,
      actorName: ctx.session.name,
      detail: { id: policy.id, name: policy.name, effect: policy.effect, enabled: policy.enabled },
    })
    await recordAuditLogFromRequest(request, {
      action: AUDIT_ACTIONS.accessPolicyUpdate,
      result: "success",
      entityType: "access_policy",
      entityId: policy.id,
      entityLabel: policy.name,
      after: { name: policy.name, effect: policy.effect, enabled: policy.enabled },
      context: { tenantId: ctx.tenantId, actorUserId: ctx.session.userId, actorName: ctx.session.name, actorEmail: ctx.session.email },
    })
    return NextResponse.json({ policy })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  await deleteAccessPolicy(ctx.tenantId, Number(id))
  await recordSecurityEvent({
    tenantId: ctx.tenantId,
    category: "access_policy",
    action: "policy_deleted",
    outcome: "deleted",
    actorUserId: ctx.session.userId,
    actorName: ctx.session.name,
    detail: { id: Number(id) },
  })
  return NextResponse.json({ ok: true })
}
