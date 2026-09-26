import { NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { getFeatureChecker } from "@/lib/permissions"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"
import { isPolicyDomain } from "@/lib/setting-inheritance/policies"
import { isScopeLevel } from "@/lib/setting-inheritance/model"
import {
  SettingInheritanceError,
  resolvePolicyDomain,
  setPolicyOverride,
  type PolicyScopeContext,
} from "@/lib/setting-inheritance/store"

const GOVERNANCE_GRANT = "masterdata.change"

/** Parse a positive int query param, or null when absent/invalid. */
function parseScopeParam(url: URL, key: string): number | null {
  const raw = url.searchParams.get(key)
  if (raw == null || raw === "") return null
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function scopeFromRequest(url: URL): PolicyScopeContext {
  return {
    companyId: parseScopeParam(url, "companyId"),
    branchId: parseScopeParam(url, "branchId"),
    departmentId: parseScopeParam(url, "departmentId"),
    userId: parseScopeParam(url, "userId"),
  }
}

function errorResponse(err: unknown) {
  if (err instanceof SettingInheritanceError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
  }
  console.error("[master-data/policies] failed:", (err as Error).message)
  return NextResponse.json({ error: "Could not process policy request" }, { status: 500 })
}

export async function GET(request: Request, { params }: { params: Promise<{ domain: string }> }) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { session, tenantId } = auth

  const { domain } = await params
  if (!isPolicyDomain(domain)) return NextResponse.json({ error: "Unknown policy domain" }, { status: 404 })

  const can = await getFeatureChecker(session.userId, session.role)
  if (!can(GOVERNANCE_GRANT)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const ctx = scopeFromRequest(new URL(request.url))
    const entries = await resolvePolicyDomain(tenantId, domain, ctx)
    return NextResponse.json({ domain, scope: ctx, entries }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ domain: string }> }) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { session, tenantId } = auth

  const { domain } = await params
  if (!isPolicyDomain(domain)) return NextResponse.json({ error: "Unknown policy domain" }, { status: 404 })

  const can = await getFeatureChecker(session.userId, session.role)
  const hasGovernanceGrant = can(GOVERNANCE_GRANT)
  if (!hasGovernanceGrant) {
    await recordAuditLogFromRequest(request, { action: "masterdata.policy.override", result: "denied", entityType: "setting_override" })
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const level = body?.level
  if (!isScopeLevel(level)) return NextResponse.json({ error: "Invalid scope level" }, { status: 400 })

  try {
    const result = await setPolicyOverride(
      tenantId,
      {
        key: String(body?.key ?? ""),
        level,
        scopeId: body?.scopeId == null ? null : Number(body.scopeId),
        value: body?.value == null ? null : String(body.value),
      },
      { userId: session.userId, isAdmin: session.role === "admin", hasGovernanceGrant },
    )

    await recordAuditLogFromRequest(request, {
      action: "masterdata.policy.override",
      entityType: "setting_override",
      entityLabel: `${result.key} @ ${result.level}`,
      // Never log the raw value of a governed/secret policy — record the action only.
      metadata: {
        key: result.key,
        level: result.level,
        scopeId: result.scopeId,
        action: result.action,
        governed: result.governed,
      },
    })

    return NextResponse.json(result)
  } catch (err) {
    return errorResponse(err)
  }
}
