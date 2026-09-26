import "server-only"
import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { getUserDomainScope, resolveDataScopeContext } from "@/lib/data-scope-store"
import { ensureRiskComplianceSchema } from "./schema"
import {
  RISK_SCOPE_DOMAIN,
  RiskScopeError,
  parseScopeInput,
  resolveRiskScope,
  type ResolvedScope,
} from "./scope"

export type RiskAccess = {
  ok: true
  tenantId: number
  userId: number
  isOwner: boolean
  resolved: ResolvedScope
}

/**
 * Shared gate for every /api/admin/risk-compliance route:
 * tenant-admin guard → tenant from session (never client) → validated scope →
 * intersected with the caller's `risk.compliance` data-scope grant.
 */
export async function authorizeRiskRequest(
  levelRaw: unknown,
  valueRaw: unknown,
): Promise<RiskAccess | { ok: false; response: NextResponse }> {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return { ok: false, response: NextResponse.json({ error: guard.reason }, { status: guard.status }) }
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return { ok: false, response: NextResponse.json({ error: "No tenant in context" }, { status: 403 }) }

  try {
    const requested = parseScopeInput(levelRaw, valueRaw)
    await ensureRiskComplianceSchema()
    const userId = guard.session.userId
    const kind = await getUserDomainScope(tenantId, userId, RISK_SCOPE_DOMAIN)
    const ctx =
      kind && kind !== "all"
        ? await resolveDataScopeContext(tenantId, userId)
        : { assignedEntities: [], assignedBranches: [] }
    const resolved = resolveRiskScope(requested, kind, ctx)
    return { ok: true, tenantId, userId, isOwner: guard.ctx.tenantRole === "tenant_owner", resolved }
  } catch (err) {
    if (err instanceof RiskScopeError) {
      return { ok: false, response: NextResponse.json({ error: err.message }, { status: err.status }) }
    }
    console.error("[risk-compliance] authorization failed:", (err as Error)?.message)
    return { ok: false, response: NextResponse.json({ error: "Failed to resolve access scope" }, { status: 500 }) }
  }
}
