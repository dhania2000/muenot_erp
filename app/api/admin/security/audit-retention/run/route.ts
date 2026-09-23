import { NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { runArchiveSweep } from "@/lib/audit-retention"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const dryRun = Boolean(body.dryRun)

  try {
    const result = await runArchiveSweep(tenantId, {
      force: true,
      dryRun,
      actorUserId: guard.session.userId,
    })
    if (!dryRun) {
      await recordAuditLogFromRequest(req, {
        action: "audit_retention.sweep_run",
        result: "success",
        entityType: "audit_retention_policy",
        entityId: tenantId,
        entityLabel: "Manual audit retention run",
        metadata: { archived: result.archived, batches: result.batches, purged: result.purged, heldSkipped: result.heldSkipped },
        context: {
          tenantId,
          actorUserId: guard.session.userId,
          actorName: guard.session.name,
          actorEmail: guard.session.email,
        },
      })
    }
    return NextResponse.json({ result })
  } catch (error) {
    console.error("[audit-retention] run failed", error)
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}
