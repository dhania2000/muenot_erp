import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { addItem } from "@/lib/legal-hold-store"

// add a coverage item to an active legal hold. Tenant-admin only,
// tenant-scoped, and audited.

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  try {
    const item = await addItem(tenantId, Number(id), body, {
      userId: guard.session.userId,
      name: guard.session.name,
      email: guard.session.email,
      role: guard.ctx.tenantRole,
    })
    if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json({ item }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
