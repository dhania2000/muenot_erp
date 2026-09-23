import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { deleteHold, getHold } from "@/lib/legal-hold-store"

// read / delete a single legal hold. Tenant-admin only, tenant-scoped
// (a foreign id resolves to null → 404), and audited. Active holds can never be
// deleted — they must be released first.

export const runtime = "nodejs"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const hold = await getHold(tenantId, Number(id))
  if (!hold) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ hold })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  try {
    const ok = await deleteHold(tenantId, Number(id), {
      userId: guard.session.userId,
      name: guard.session.name,
      email: guard.session.email,
      role: guard.ctx.tenantRole,
    })
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
