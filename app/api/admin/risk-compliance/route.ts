import { NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { ensureRiskComplianceSchema } from "@/lib/risk-compliance/schema"
import {
  computeRiskComplianceDashboard,
  maskDashboard,
  isStale,
  scopeKeyOf,
  type RiskScope,
  type ScopeLevel,
  type RiskComplianceDashboard,
} from "@/lib/risk-compliance/aggregate"
import { query } from "@/lib/db"

/**
 * GET /api/admin/risk-compliance — the aggregated risk & compliance dashboard.
 *
 * Tenant-admin only; tenant is bound from the guard, NEVER from client input.
 * Serves the most recent cached snapshot when it is fresh, otherwise recomputes
 * live. The response always carries `stale`/`computedAt` so the UI can flag
 * stale metrics. Sensitive fields are masked unless the caller is a tenant
 * owner (drill-down PII stays gated).
 */

const STALE_MS = 15 * 60 * 1000 // 15 minutes

const SCOPE_LEVELS: ScopeLevel[] = ["group", "company", "branch", "department"]

function parseScope(req: NextRequest): RiskScope {
  const levelRaw = (req.nextUrl.searchParams.get("level") || "group").toLowerCase()
  const level = (SCOPE_LEVELS.includes(levelRaw as ScopeLevel) ? levelRaw : "group") as ScopeLevel
  const value = req.nextUrl.searchParams.get("value")?.slice(0, 150) || null
  return { level, value: level === "group" ? null : value }
}

export async function GET(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  try {
    await ensureRiskComplianceSchema()
    const scope = parseScope(req)
    const scopeKey = scopeKeyOf(scope)
    const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1"

    // Owners may view unmasked drill-down PII; admins get masked data.
    const canViewSensitive = guard.ctx.tenantRole === "tenant_owner"

    let dash: RiskComplianceDashboard | null = null
    let fromCache = false

    if (!forceRefresh) {
      const rows = await query<any[]>(
        `SELECT payload, computed_at FROM risk_compliance_snapshots
          WHERE tenant_id = ? AND scope_key = ?
          ORDER BY computed_at DESC LIMIT 1`,
        [tenantId, scopeKey],
      )
      if (rows.length) {
        const cached = typeof rows[0].payload === "string" ? JSON.parse(rows[0].payload) : rows[0].payload
        const computedAt = new Date(rows[0].computed_at).toISOString()
        if (!isStale(computedAt, STALE_MS)) {
          dash = { ...cached, computedAt }
          fromCache = true
        }
      }
    }

    if (!dash) {
      dash = await computeRiskComplianceDashboard(tenantId, scope)
    }

    const stale = isStale(dash.computedAt, STALE_MS)
    const body = canViewSensitive ? dash : maskDashboard(dash)

    return NextResponse.json({
      ok: true,
      dashboard: body,
      meta: { fromCache, stale, staleThresholdMs: STALE_MS, canViewSensitive },
    })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || "Failed to load dashboard" }, { status: 500 })
  }
}
