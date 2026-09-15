import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { hasActionGrant } from "@/lib/permission-store"
import { FINANCE_ONLY_REPORT_MAP } from "@/lib/finance-reports"
import {
  canAccessReport,
  getReportCompany,
  runFinanceReport,
  type ReportViewer,
} from "@/lib/finance-report-run"

// Runs several Financial Reports in one call so the client can stitch them into
// a single CA package PDF (Phases 58–60). Every report goes through the SAME
// shared engine the single-report route uses, so the package carries the exact
// authoritative numbers — no second, divergent query path. Each report is
// access-checked individually; a report the viewer may not see is skipped
// rather than silently substituted.

export async function POST(req: NextRequest) {
  const session = await requireFeature("finance.financial_reports")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const viewer: ReportViewer = { userId: (session as any).userId, role: session.role }

  // Generating a package is a bulk export; gate it on the same export grant the
  // per-report Download/CSV/PDF actions require.
  const canExport = await hasActionGrant(viewer.userId, viewer.role, "finance.reports", "export_report")
  if (!canExport) {
    return NextResponse.json({ error: "You do not have permission to export reports." }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const keys: string[] = Array.isArray(body.keys) ? body.keys.map(String) : []
  const from = String(body.from || "")
  const to = String(body.to || "")
  const filters = body.filters && typeof body.filters === "object" ? body.filters : {}

  if (keys.length === 0) {
    return NextResponse.json({ error: "Select at least one report for the package." }, { status: 400 })
  }

  const reports: Array<{
    key: string
    label: string
    group: string
    description: string
    columns: unknown
    rows: Record<string, any>[]
    rowCount: number
    available: boolean
  }> = []

  for (const key of keys) {
    const def = FINANCE_ONLY_REPORT_MAP[key]
    if (!def) continue
    if (!(await canAccessReport(viewer, def))) continue

    // Period only applies to reports that are time-filtered; the engine ignores
    // from/to for `none`/as-on reports so passing them through is harmless.
    const run = await runFinanceReport({ reportKey: key, from, to, filters })
    if (!run.ok || !run.reportMeta) continue

    reports.push({
      key,
      label: run.reportMeta.label,
      group: run.reportMeta.group,
      description: run.reportMeta.description,
      columns: run.reportMeta.columns,
      rows: run.rows,
      rowCount: run.rows.length,
      available: run.available,
    })
  }

  if (reports.length === 0) {
    return NextResponse.json({ error: "None of the selected reports are available to you." }, { status: 403 })
  }

  const company = await getReportCompany()

  return NextResponse.json({
    company,
    generatedAt: new Date().toISOString(),
    generatedBy: session.name || "",
    reports,
  })
}
