import { NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { releaseLegalHold } from "@/lib/audit-retention"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"

export const dynamic = "force-dynamic"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const { id } = await params
  const holdId = Number(id)
  if (!Number.isFinite(holdId)) return NextResponse.json({ error: "Invalid hold id" }, { status: 400 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    const hold = await releaseLegalHold(tenantId, holdId, {
      releasedBy: guard.session.userId,
      releasedByName: guard.session.name,
      reason: body.reason ? String(body.reason) : null,
    })
    if (!hold) return NextResponse.json({ error: "Legal hold not found" }, { status: 404 })
    await recordAuditLogFromRequest(req, {
      action: "audit_retention.legal_hold_release",
      result: "success",
      entityType: "audit_legal_hold",
      entityId: hold.id,
      entityLabel: hold.name,
      metadata: { reason: body.reason ?? null },
      context: {
        tenantId,
        actorUserId: guard.session.userId,
        actorName: guard.session.name,
        actorEmail: guard.session.email,
      },
    })
    return NextResponse.json({ hold })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
