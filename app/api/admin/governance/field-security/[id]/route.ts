import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { deleteFieldSecurityPolicy, updateFieldSecurityPolicy } from "@/lib/field-security"

// update / delete a single field-security policy. Tenant-admin only,
// tenant-scoped (a foreign id resolves to null → 404), and audited.

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const actor = {
    userId: guard.session.userId,
    name: guard.session.name,
    email: guard.session.email,
    role: guard.ctx.tenantRole,
  }
  try {
    const policy = await updateFieldSecurityPolicy(
      tenantId,
      Number(id),
      {
        module: body.module,
        entity: body.entity,
        field: body.field,
        category: body.category,
        scopeType: body.scopeType,
        scopeValue: body.scopeValue ?? "",
        effect: body.effect,
        enabled: body.enabled ?? true,
      },
      actor,
    )
    if (!policy) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json({ policy })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const ok = await deleteFieldSecurityPolicy(tenantId, Number(id), {
    userId: guard.session.userId,
    name: guard.session.name,
    email: guard.session.email,
    role: guard.ctx.tenantRole,
  })
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
