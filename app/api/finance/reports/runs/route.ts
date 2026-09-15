import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { hasActionGrant } from "@/lib/permission-store"
import {
  listReportRuns,
  logReportRun,
  type ReportRunFormat,
} from "@/lib/finance-report-runs"

// Download + Email history for Financial Reports (Phases 18–19). GET lists the
// run log; POST records a client-side download (PDF / Excel / CSV). Emailed
// reports are logged server-side by the report email route, so both surfaces
// share the one `finance_report_runs` table and this one view.

const DOWNLOAD_FORMATS = new Set<ReportRunFormat>(["PDF", "Excel", "CSV"])

export async function GET(req: NextRequest) {
  const session = await requireFeature("finance.financial_reports")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const formatParam = (sp.get("format") || "all") as ReportRunFormat | "all"

  const result = await listReportRuns({
    format: formatParam,
    reportKey: sp.get("report") || undefined,
    q: sp.get("q") || undefined,
    page: Number(sp.get("page") || 1),
    pageSize: Number(sp.get("pageSize") || 25),
  })

  return NextResponse.json(result)
}

export async function POST(req: NextRequest) {
  const session = await requireFeature("finance.financial_reports")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const reportKey = String(body.report_key || "").trim()
  const format = String(body.format || "").trim() as ReportRunFormat

  if (!reportKey) return NextResponse.json({ error: "A report is required" }, { status: 400 })
  if (!DOWNLOAD_FORMATS.has(format)) {
    return NextResponse.json({ error: "Invalid download format" }, { status: 400 })
  }

  // Phase 32 — exporting is a distinct privilege from viewing. The client
  // hides download actions when this grant is absent; enforce it here too so
  // the audit log can't be written (and the file implicitly sanctioned) by a
  // viewer who lacks export rights.
  const canExport = await hasActionGrant(
    (session as any).userId,
    session.role,
    "finance.reports",
    "export_report",
  )
  if (!canExport) {
    return NextResponse.json({ error: "You do not have permission to export reports." }, { status: 403 })
  }

  const id = await logReportRun({
    reportKey,
    reportLabel: String(body.report_label || reportKey),
    format,
    periodLabel: body.period_label ? String(body.period_label) : null,
    filtersText: body.filters_text ? String(body.filters_text) : null,
    status: "Downloaded",
    userId: (session as any).userId ?? null,
    userName: session.name || null,
    rowCount: Number.isFinite(Number(body.row_count)) ? Number(body.row_count) : null,
  })

  return NextResponse.json({ ok: true, id })
}
