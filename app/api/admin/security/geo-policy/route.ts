import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { getGeoPolicy, upsertGeoPolicy, type GeoPolicyInput } from "@/lib/geo-policy-store"
import { resolveGeoTrustSource } from "@/lib/geo-trust"
import { recordAuditLogFromRequest, AUDIT_ACTIONS } from "@/lib/audit-log-store"

// Tenant scope always comes from the resolved tenant context, never the body.
async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  return { session, tenantId: tenant?.tenantId ?? null }
}

export async function GET() {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const policy = await getGeoPolicy(ctx.tenantId)
  return NextResponse.json({ policy, geoSource: resolveGeoTrustSource() })
}

export async function PUT(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (ctx.tenantId == null) return NextResponse.json({ error: "Tenant context required" }, { status: 400 })

  const body = (await request.json().catch(() => null)) as GeoPolicyInput | null
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  const before = await getGeoPolicy(ctx.tenantId)
  try {
    // Upsert keyed by tenant: replaying the same PUT is idempotent.
    const policy = await upsertGeoPolicy(ctx.tenantId, { userId: ctx.session.userId, name: ctx.session.name }, body)
    await recordAuditLogFromRequest(request, {
      action: AUDIT_ACTIONS.geoPolicyUpdate,
      result: "success",
      entityType: "geo_policy",
      entityId: ctx.tenantId,
      entityLabel: "Geo policy",
      before: { enabled: before.enabled, mode: before.mode, countries: before.countries, unknownAction: before.unknownAction, emergencyAccess: before.emergencyAccess },
      after: { enabled: policy.enabled, mode: policy.mode, countries: policy.countries, unknownAction: policy.unknownAction, emergencyAccess: policy.emergencyAccess },
      context: { tenantId: ctx.tenantId, actorUserId: ctx.session.userId, actorName: ctx.session.name, actorEmail: ctx.session.email },
    })
    return NextResponse.json({ policy })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
