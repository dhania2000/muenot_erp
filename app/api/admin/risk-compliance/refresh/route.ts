import { NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { ensureRiskComplianceSchema } from "@/lib/risk-compliance/schema"
import { computeRiskComplianceDashboard, scopeKeyOf, type RiskScope, type ScopeLevel } from "@/lib/risk-compliance/aggregate"
import { query } from "@/lib/db"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"

/**
 * POST /api/admin/risk-compliance/refresh — recompute and cache a snapshot.
 *
 * Idempotent: pass an `Idempotency-Key` header (or `idempotencyKey` in the body)
 * and a retry with the same key returns the already-stored snapshot instead of
 * recomputing/duplicating. The write is audited. Tenant is bound from the guard.
 */

const SCOPE_LEVELS: ScopeLevel[] = ["group", "company", "branch", "department"]

export async function POST(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  try {
    await ensureRiskComplianceSchema()

    const body = await req.json().catch(() => ({}))
    const levelRaw = String(body?.level ?? "group").toLowerCase()
    const level = (SCOPE_LEVELS.includes(levelRaw as ScopeLevel) ? levelRaw : "group") as ScopeLevel
    const value = level === "group" ? null : (typeof body?.value === "string" ? body.value.slice(0, 150) : null)
    const scope: RiskScope = { level, value }
    const scopeKey = scopeKeyOf(scope)

    const idempotencyKey =
      (req.headers.get("idempotency-key") || (typeof body?.idempotencyKey === "string" ? body.idempotencyKey : "")).slice(0, 100) ||
      null

    // Idempotent replay: same key -> return the stored snapshot untouched.
    if (idempotencyKey) {
      const existing = await query<any[]>(
        `SELECT payload, computed_at FROM risk_compliance_snapshots
          WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
        [tenantId, idempotencyKey],
      )
      if (existing.length) {
        const cached = typeof existing[0].payload === "string" ? JSON.parse(existing[0].payload) : existing[0].payload
        return NextResponse.json({ ok: true, replayed: true, dashboard: cached })
      }
    }

    const dash = await computeRiskComplianceDashboard(tenantId, scope)

    await query(
      `INSERT INTO risk_compliance_snapshots (tenant_id, scope_key, payload, computed_at, computed_by, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [tenantId, scopeKey, JSON.stringify(dash), new Date(dash.computedAt), guard.session.userId, idempotencyKey],
    )

    await recordAuditLogFromRequest(req, {
      action: "risk_compliance.refresh",
      entityType: "risk_compliance_snapshot",
      entityId: scopeKey,
      metadata: {
        scope,
        openItems: dash.totals.openItems,
        sourcesAvailable: dash.totals.sourcesAvailable,
        sourcesMissing: dash.totals.sourcesMissing,
      },
    })

    return NextResponse.json({ ok: true, replayed: false, dashboard: dash })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || "Failed to refresh" }, { status: 500 })
  }
}
