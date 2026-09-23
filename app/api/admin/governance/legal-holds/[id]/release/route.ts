import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { releaseHold } from "@/lib/legal-hold-store"

// release a legal hold. Recording a reason is mandatory; the release
// (with actor + reason) is written to the immutable audit log. Once released,
// the covered records/files resume following their retention policies.

export const runtime = "nodejs"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as { reason?: unknown }
  try {
    const hold = await releaseHold(tenantId, Number(id), String(body.reason ?? ""), {
      userId: guard.session.userId,
      name: guard.session.name,
      email: guard.session.email,
      role: guard.ctx.tenantRole,
    })
    if (!hold) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json({ hold })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
