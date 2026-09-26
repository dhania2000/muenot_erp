import { NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { ensureRiskComplianceSchema } from "@/lib/risk-compliance/schema"
import {
  computeRiskComplianceDashboard,
  maskDashboard,
  scopeKeyOf,
  type RiskScope,
  type ScopeLevel,
} from "@/lib/risk-compliance/aggregate"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"

/**
 * GET /api/admin/risk-compliance/export — CSV export of the dashboard.
 *
 * Exports are ALWAYS masked for sensitive fields unless the caller is a tenant
 * owner AND explicitly requests `unmasked=1`. The export is audited, recording
 * whether sensitive data was included, so unmasked pulls are attributable.
 */

const SCOPE_LEVELS: ScopeLevel[] = ["group", "company", "branch", "department"]

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v)
  return `"${s.replace(/"/g, '""')}"`
}

export async function GET(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  try {
    await ensureRiskComplianceSchema()

    const levelRaw = (req.nextUrl.searchParams.get("level") || "group").toLowerCase()
    const level = (SCOPE_LEVELS.includes(levelRaw as ScopeLevel) ? levelRaw : "group") as ScopeLevel
    const value = level === "group" ? null : req.nextUrl.searchParams.get("value")?.slice(0, 150) || null
    const scope: RiskScope = { level, value }

    const isOwner = guard.ctx.tenantRole === "tenant_owner"
    const wantsUnmasked = req.nextUrl.searchParams.get("unmasked") === "1"
    // Sensitive export masking: only a tenant owner can opt out of masking.
    const unmasked = isOwner && wantsUnmasked

    const raw = await computeRiskComplianceDashboard(tenantId, scope)
    const dash = unmasked ? raw : maskDashboard(raw)

    const header = ["category", "source", "available", "severity", "item", "detail", "amount", "occurred_at"]
    const lines = [header.map(csvCell).join(",")]
    for (const s of dash.sources) {
      if (!s.items.length) {
        lines.push([s.category, s.label, s.available ? "yes" : "no", s.severity, "", s.note ?? "", "", s.asOf ?? ""].map(csvCell).join(","))
        continue
      }
      for (const it of s.items) {
        lines.push(
          [s.category, s.label, s.available ? "yes" : "no", it.severity, it.label, it.detail ?? "", it.amount ?? "", it.occurredAt ?? ""]
            .map(csvCell)
            .join(","),
        )
      }
    }
    const csv = lines.join("\r\n")

    await recordAuditLogFromRequest(req, {
      action: "risk_compliance.export",
      entityType: "risk_compliance_snapshot",
      entityId: scopeKeyOf(scope),
      metadata: { scope, unmasked, rows: lines.length - 1 },
    })

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="risk-compliance-${scope.level}.csv"`,
      },
    })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || "Failed to export" }, { status: 500 })
  }
}
