import { NextRequest, NextResponse } from "next/server"
import { recordAuditLogFromRequest } from "@/lib/audit-log-store"
import { authorizeRiskRequest } from "@/lib/risk-compliance/access"
import { computeRiskComplianceDashboard, maskDashboard } from "@/lib/risk-compliance/aggregate"
import { scopeKeyOf } from "@/lib/risk-compliance/scope"

/**
 * GET /api/admin/risk-compliance/export — CSV export.
 * Masked unless the caller is a tenant owner AND passes `unmasked=1`. Every
 * export is audited with whether sensitive data was included.
 */

/** Quote a CSV cell and neutralise spreadsheet formula injection. */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const access = await authorizeRiskRequest(sp.get("level"), sp.get("value"))
  if (!access.ok) return access.response
  const { tenantId, isOwner, resolved } = access
  const scope = resolved.scope
  const unmasked = isOwner && sp.get("unmasked") === "1"

  try {
    const raw = await computeRiskComplianceDashboard(tenantId, scope)
    const dash = unmasked ? raw : maskDashboard(raw)

    const header = ["category", "source", "status", "severity", "item", "detail", "sensitive", "amount", "occurred_at", "drill_href"]
    const lines = [header.map(csvCell).join(",")]
    for (const s of dash.sources) {
      const status = !s.available ? "unavailable" : s.withheld ? "withheld" : "ok"
      if (!s.items.length) {
        lines.push([s.category, s.label, status, s.severity, "", s.note ?? "", "", "", s.asOf ?? "", s.drillHref].map(csvCell).join(","))
        continue
      }
      for (const it of s.items) {
        const sensitive = it.sensitive ? Object.entries(it.sensitive).map(([k, v]) => `${k}=${v}`).join("; ") : ""
        lines.push(
          [s.category, s.label, status, it.severity, it.label, it.detail ?? "", sensitive, it.amount ?? "", it.occurredAt ?? "", s.drillHref]
            .map(csvCell)
            .join(","),
        )
      }
    }

    await recordAuditLogFromRequest(req, {
      action: "risk_compliance.export",
      entityType: "risk_compliance_snapshot",
      entityId: scopeKeyOf(scope),
      metadata: { scope, unmasked, rows: lines.length - 1 },
    })

    return new NextResponse(lines.join("\r\n"), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="risk-compliance-${scope.level}.csv"`,
        "cache-control": "no-store",
      },
    })
  } catch (err) {
    console.error("[risk-compliance] export failed:", (err as Error)?.message)
    return NextResponse.json({ error: "Failed to export" }, { status: 500 })
  }
}
