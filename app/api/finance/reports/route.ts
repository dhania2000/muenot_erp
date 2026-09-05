import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { FINANCE_REPORTS, FINANCE_REPORT_MAP } from "@/lib/finance-reports"

// One route serves every Financial Report. Without a `report` param it returns
// the report catalogue (used to build the picker); with one it runs that
// report's aggregate query, optionally filtered by a date range. Each query is
// run defensively: a missing source table/column yields an empty result set
// rather than a 500, so the whole reports hub stays usable as data is added.

export async function GET(req: NextRequest) {
  const session = await requireFeature("finance.financial_reports")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const params = req.nextUrl.searchParams
  const reportKey = params.get("report")

  const catalogue = FINANCE_REPORTS.map((r) => ({
    key: r.key,
    label: r.label,
    group: r.group,
    description: r.description,
  }))

  if (!reportKey) {
    return NextResponse.json({ reports: catalogue })
  }

  const def = FINANCE_REPORT_MAP[reportKey]
  if (!def) return NextResponse.json({ error: "Unknown report" }, { status: 404 })

  const from = params.get("from") || ""
  const to = params.get("to") || ""

  const args: any[] = []
  let rangeSql = ""
  if (def.dateColumn) {
    if (from) { rangeSql += ` AND ${def.dateColumn} >= ?`; args.push(from) }
    if (to) { rangeSql += ` AND ${def.dateColumn} <= ?`; args.push(to) }
  }
  const sql = def.sql.replaceAll("{{range}}", rangeSql)

  let rows: any[] = []
  let available = true
  try {
    rows = (await query(sql, args)) as any[]
  } catch (err) {
    // Source table/column not present yet — surface an empty report instead of failing.
    console.log("[v0] report query failed for", reportKey, (err as Error).message)
    available = false
    rows = []
  }

  return NextResponse.json({
    report: {
      key: def.key,
      label: def.label,
      group: def.group,
      description: def.description,
      columns: def.columns,
      hasDateFilter: !!def.dateColumn,
    },
    rows,
    available,
  })
}
