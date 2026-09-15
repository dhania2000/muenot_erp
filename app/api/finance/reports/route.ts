import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { hasActionGrant } from "@/lib/permission-store"
import { FINANCE_ONLY_REPORT_MAP, FINANCE_ONLY_REPORTS } from "@/lib/finance-reports"
import {
  canAccessReport,
  filterAccessibleReports,
  getReportCompany,
  reportFilterMeta,
  runFinanceReport,
  type ReportViewer,
} from "@/lib/finance-report-run"

// One route serves every Financial Report. Without a `report` param it returns
// the report catalogue (used to build the picker); with one it runs that
// report's aggregate query through the shared engine (lib/finance-report-run),
// optionally filtered by a date range and any of the report's declared
// dimension filters. The same engine backs the report email route, so both
// paths produce identical numbers. Each query is run defensively: a missing
// source table/column yields an empty result set rather than a 500.

export async function GET(req: NextRequest) {
  const session = await requireFeature("finance.financial_reports")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const viewer: ReportViewer = { userId: (session as any).userId, role: session.role }
  const params = req.nextUrl.searchParams
  const reportKey = params.get("report")

  if (!reportKey) {
    // Phase 33 — report data security: a viewer only sees reports drawn from
    // finance modules they can VIEW, so revoking a module's access also hides
    // the reports built on it. Phase 32 — surface whether this viewer may
    // download/email so the client can hide those actions rather than let a
    // request fail server-side.
    const accessible = await filterAccessibleReports(viewer, FINANCE_ONLY_REPORTS)
    const catalogue = accessible.map((r) => ({
      key: r.key,
      label: r.label,
      group: r.group,
      description: r.description,
      periodMode: r.periodMode ?? (r.dateColumn ? "range" : "none"),
      filters: reportFilterMeta(r),
    }))
    const [canExport, canEmail] = await Promise.all([
      hasActionGrant(viewer.userId, viewer.role, "finance.reports", "export_report"),
      hasActionGrant(viewer.userId, viewer.role, "finance.reports", "email_report"),
    ])
    return NextResponse.json({ reports: catalogue, capabilities: { canExport, canEmail } })
  }

  // Phase 33 — enforce access on the report run itself, not just the catalogue,
  // so a hand-crafted request can't pull a report the viewer may not see.
  const def = FINANCE_ONLY_REPORT_MAP[reportKey]
  if (def && !(await canAccessReport(viewer, def))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const filters: Record<string, string> = {}
  for (const [k, v] of params.entries()) {
    if (k.startsWith("f_")) filters[k.slice(2)] = v
  }

  const run = await runFinanceReport({
    reportKey,
    from: params.get("from") || "",
    to: params.get("to") || "",
    filters,
  })

  if (!run.ok || !run.reportMeta) {
    return NextResponse.json({ error: run.error || "Unknown report" }, { status: run.status })
  }

  const company = await getReportCompany()

  return NextResponse.json({
    report: run.reportMeta,
    rows: run.rows,
    available: run.available,
    diagnostics: run.diagnostics ?? null,
    company,
    generatedAt: new Date().toISOString(),
    generatedBy: session.name || "",
  })
}
