import { NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff } from "@/lib/platform-guard"
import { getPlatformPolicy, setPlatformPolicy, getRetentionSummary, PLATFORM_SCOPE } from "@/lib/audit-retention"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"

export const dynamic = "force-dynamic"

export async function GET() {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  try {
    const [policy, summary] = await Promise.all([getPlatformPolicy(), getRetentionSummary(PLATFORM_SCOPE)])
    return NextResponse.json({ policy, summary })
  } catch (error) {
    console.error("[platform audit-retention] load failed", error)
    return NextResponse.json({ error: "Unable to load platform audit retention" }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    const before = await getPlatformPolicy()
    const policy = await setPlatformPolicy(
      {
        defaultRetentionDays: body.defaultRetentionDays != null ? Number(body.defaultRetentionDays) : undefined,
        minRetentionDays: body.minRetentionDays != null ? Number(body.minRetentionDays) : undefined,
        archiveEnabled: body.archiveEnabled as boolean | undefined,
        purgeAfterArchive: body.purgeAfterArchive as boolean | undefined,
      },
      guard.session.userId,
    )
    await recordAuditLogFromRequest(req, {
      action: "audit_retention.platform_policy_update",
      result: "success",
      entityType: "audit_retention_platform_policy",
      entityId: "platform",
      entityLabel: "Platform audit retention policy",
      before: before as unknown as Record<string, unknown>,
      after: policy as unknown as Record<string, unknown>,
      context: {
        tenantId: null,
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
