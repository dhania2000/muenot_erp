import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { FINANCE_ONLY_REPORTS } from "@/lib/finance-reports"
import {
  getReportCompany,
  reportFilterMeta,
  runFinanceReport,
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

  const params = req.nextUrl.searchParams
  const reportKey = params.get("report")

  if (!reportKey) {
    const catalogue = FINANCE_ONLY_REPORTS.map((r) => ({
      key: r.key,
      label: r.label,
      group: r.group,
      description: r.description,
      periodMode: r.periodMode ?? (r.dateColumn ? "range" : "none"),
      filters: reportFilterMeta(r),
    }))
    return NextResponse.json({ reports: catalogue })
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
    company,
    generatedAt: new Date().toISOString(),
    generatedBy: session.name || "",
  })
}
