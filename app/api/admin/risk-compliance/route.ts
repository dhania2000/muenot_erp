import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { authorizeRiskRequest } from "@/lib/risk-compliance/access"
import {
  computeRiskComplianceDashboard,
  isStale,
  maskDashboard,
  type RiskComplianceDashboard,
} from "@/lib/risk-compliance/aggregate"
import { scopeKeyOf } from "@/lib/risk-compliance/scope"

/**
 * GET /api/admin/risk-compliance — aggregated risk & compliance dashboard.
 * Serves the latest snapshot for the (permission-resolved) scope while fresh,
 * otherwise recomputes live. Non-owners always receive masked PII.
 */

export const STALE_MS = 15 * 60 * 1000

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const access = await authorizeRiskRequest(sp.get("level"), sp.get("value"))
  if (!access.ok) return access.response
  const { tenantId, isOwner, resolved } = access
  const scope = resolved.scope
  const scopeKey = scopeKeyOf(scope)

  try {
    let dash: RiskComplianceDashboard | null = null
    let fromCache = false

    if (sp.get("refresh") !== "1") {
      const rows = await query<any[]>(
        `SELECT payload, computed_at FROM risk_compliance_snapshots
          WHERE tenant_id = ? AND scope_key = ?
          ORDER BY computed_at DESC, id DESC LIMIT 1`,
        [tenantId, scopeKey],
      )
      if (rows.length) {
        const cached = typeof rows[0].payload === "string" ? JSON.parse(rows[0].payload) : rows[0].payload
        const computedAt = new Date(rows[0].computed_at).toISOString()
        // Defense in depth: never serve a payload computed for another tenant/scope.
        if (cached?.tenantId === tenantId && cached?.scopeKey === scopeKey && !isStale(computedAt, STALE_MS)) {
          dash = { ...cached, computedAt }
          fromCache = true
        }
      }
    }

    dash ??= await computeRiskComplianceDashboard(tenantId, scope)
    const ageMs = Math.max(0, Date.now() - new Date(dash.computedAt).getTime())

    return NextResponse.json({
      ok: true,
      dashboard: isOwner ? dash : maskDashboard(dash),
      meta: {
        fromCache,
        stale: isStale(dash.computedAt, STALE_MS),
        ageMs,
        staleThresholdMs: STALE_MS,
        canViewSensitive: isOwner,
        restricted: resolved.restricted,
        narrowed: resolved.narrowed,
        allowed: resolved.allowed,
      },
    })
  } catch (err) {
    console.error("[risk-compliance] GET failed:", (err as Error)?.message)
    return NextResponse.json({ error: "Failed to load dashboard" }, { status: 500 })
  }
}
