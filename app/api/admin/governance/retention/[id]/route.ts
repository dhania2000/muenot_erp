import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { deletePolicy, getPolicy, listExceptions, listRuns, updatePolicy } from "@/lib/retention-engine"

// read / update / delete a single retention policy. Tenant-admin
// only, tenant-scoped (a foreign id resolves to null → 404), and audited.

export const runtime = "nodejs"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const policyId = Number(id)
  const policy = await getPolicy(tenantId, policyId)
  if (!policy) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const [exceptions, runs] = await Promise.all([
    listExceptions(tenantId, policyId),
    listRuns(tenantId, policyId),
  ])
  return NextResponse.json({ policy, exceptions, runs })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const actor = {
    userId: guard.session.userId,
    name: guard.session.name,
    email: guard.session.email,
    role: guard.ctx.tenantRole,
  }
  const body = await request.json().catch(() => ({}))
  try {
    const policy = await updatePolicy(tenantId, Number(id), body, actor)
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
  const ok = await deletePolicy(tenantId, Number(id), {
    userId: guard.session.userId,
    name: guard.session.name,
    email: guard.session.email,
    role: guard.ctx.tenantRole,
  })
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
