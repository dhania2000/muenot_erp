import { NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import {
  getResolvedTenantPolicy,
  setTenantPolicy,
  getRetentionSummary,
  listLegalHolds,
  listArchiveBatches,
} from "@/lib/audit-retention"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"

export const dynamic = "force-dynamic"

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  try {
    const [summary, holds, archives] = await Promise.all([
      getRetentionSummary(tenantId),
      listLegalHolds(tenantId),
      listArchiveBatches(tenantId, 100),
    ])
    return NextResponse.json({ summary, holds, archives })
  } catch (error) {
    console.error("[audit-retention] load failed", error)
    return NextResponse.json({ error: "Unable to load audit retention" }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    const before = await getResolvedTenantPolicy(tenantId)
    const policy = await setTenantPolicy(
      tenantId,
      {
        retentionDays: body.retentionDays != null ? Number(body.retentionDays) : undefined,
        archiveEnabled: body.archiveEnabled as boolean | undefined,
        purgeAfterArchive: body.purgeAfterArchive as boolean | undefined,
        enabled: body.enabled as boolean | undefined,
      },
      guard.session.userId,
    )
    await recordAuditLogFromRequest(req, {
      action: "audit_retention.policy_update",
      result: "success",
      entityType: "audit_retention_policy",
      entityId: tenantId,
      entityLabel: "Tenant audit retention policy",
      before: {
        retentionDays: before.retentionDays,
        archiveEnabled: before.archiveEnabled,
        purgeAfterArchive: before.purgeAfterArchive,
        enabled: before.enabled,
      },
      after: {
        retentionDays: policy.retentionDays,
        archiveEnabled: policy.archiveEnabled,
        purgeAfterArchive: policy.purgeAfterArchive,
        enabled: policy.enabled,
      },
      context: {
        tenantId,
        actorUserId: guard.session.userId,
        actorName: guard.session.name,
        actorEmail: guard.session.email,
      },
    })
    return NextResponse.json({ policy })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
