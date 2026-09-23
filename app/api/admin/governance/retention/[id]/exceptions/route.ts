import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { createException, listExceptions } from "@/lib/retention-engine"

// retention policy exceptions (records/criteria carved out of a
// policy). Tenant-admin only, tenant-scoped, audited.

export const runtime = "nodejs"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const exceptions = await listExceptions(tenantId, Number(id))
  return NextResponse.json({ exceptions })
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  try {
    const exception = await createException(tenantId, Number(id), body, {
      userId: guard.session.userId,
      name: guard.session.name,
      email: guard.session.email,
      role: guard.ctx.tenantRole,
    })
    if (!exception) return NextResponse.json({ error: "Policy not found" }, { status: 404 })
    return NextResponse.json({ exception }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
