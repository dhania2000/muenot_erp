import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { removeItem } from "@/lib/legal-hold-store"

// SPEC 72 — remove a coverage item from an active legal hold. Tenant-admin
// only, tenant-scoped, and audited.

export const runtime = "nodejs"

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id, itemId } = await params
  try {
    const ok = await removeItem(tenantId, Number(id), Number(itemId), {
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
