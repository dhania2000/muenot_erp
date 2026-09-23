import { NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { createLegalHold, listLegalHolds } from "@/lib/audit-retention"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"

export const dynamic = "force-dynamic"

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })
  const holds = await listLegalHolds(tenantId)
  return NextResponse.json({ holds })
}

export async function POST(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    const hold = await createLegalHold(tenantId, {
      name: String(body.name ?? ""),
      reason: body.reason ? String(body.reason) : null,
      filter: {
        action: body.action ? String(body.action) : null,
        entityType: body.entityType ? String(body.entityType) : null,
        actorUserId: body.actorUserId != null && body.actorUserId !== "" ? Number(body.actorUserId) : null,
        fromDate: body.fromDate ? String(body.fromDate) : null,
        toDate: body.toDate ? String(body.toDate) : null,
      },
      createdBy: guard.session.userId,
      createdByName: guard.session.name,
    })
    await recordAuditLogFromRequest(req, {
      action: "audit_retention.legal_hold_create",
      result: "success",
      entityType: "audit_legal_hold",
      entityId: hold.id,
      entityLabel: hold.name,
      after: { name: hold.name, filter: hold.filter },
      context: {
        tenantId,
        actorUserId: guard.session.userId,
        actorName: guard.session.name,
        actorEmail: guard.session.email,
      },
    })
    return NextResponse.json({ hold }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
