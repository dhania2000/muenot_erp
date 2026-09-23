import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { deleteException } from "@/lib/retention-engine"

// remove a single retention exception. Tenant-admin only, tenant-scoped, audited.

export const runtime = "nodejs"

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; exceptionId: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id, exceptionId } = await params
  const ok = await deleteException(tenantId, Number(id), Number(exceptionId), {
    userId: guard.session.userId,
    name: guard.session.name,
    email: guard.session.email,
    role: guard.ctx.tenantRole,
  })
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
