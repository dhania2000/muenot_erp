import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import {
  FINANCE_ONLY_REPORTS,
  FINANCE_ONLY_REPORT_MAP,
  FILTER_DIM_LABELS,
  type ReportDef,
} from "@/lib/finance-reports"

// One route serves every Financial Report. Without a `report` param it returns
// the report catalogue (used to build the picker); with one it runs that
// report's aggregate query, optionally filtered by a date range and any of the
// report's declared dimension filters. Each query is run defensively: a missing
// source table/column yields an empty result set rather than a 500, so the whole
// reports hub stays usable as data is added.

// Serialise a report's declared filters into the { dim, label } shape the UI
// renders. Kept here so the picker and the query use one source of truth.
function filterMeta(def: ReportDef) {
  return (def.filters ?? []).map((f) => ({ dim: f.dim, label: FILTER_DIM_LABELS[f.dim] }))
}

export async function GET(req: NextRequest) {
  const session = await requireFeature("finance.financial_reports")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const params = req.nextUrl.searchParams
  const reportKey = params.get("report")

  const catalogue = FINANCE_ONLY_REPORTS.map((r) => ({
    key: r.key,
    label: r.label,
    group: r.group,
    description: r.description,
    periodMode: r.periodMode ?? (r.dateColumn ? "range" : "none"),
    filters: filterMeta(r),
  }))

  if (!reportKey) {
    return NextResponse.json({ reports: catalogue })
  }

  const def = FINANCE_ONLY_REPORT_MAP[reportKey]
  if (!def) return NextResponse.json({ error: "Unknown report" }, { status: 404 })

  const reportMeta = {
    key: def.key,
    label: def.label,
    group: def.group,
    description: def.description,
    columns: def.columns,
    hasDateFilter: !!def.dateColumn,
    periodMode: def.periodMode ?? (def.dateColumn ? "range" : "none"),
    filters: filterMeta(def),
  }

  // Placeholder reports have no query yet — surface an empty, unavailable result.
  if (!def.sql) {
    return NextResponse.json({ report: reportMeta, rows: [], available: false })
  }

  const from = params.get("from") || ""
  const to = params.get("to") || ""

  const args: any[] = []
  // The `{{range}}` marker is where every dynamic WHERE fragment is spliced in:
  // first the date range, then each active dimension filter, in the same order
  // their bind parameters are pushed.
  let injected = ""
  if (def.dateColumn) {
    if (from) { injected += ` AND ${def.dateColumn} >= ?`; args.push(from) }
    if (to) { injected += ` AND ${def.dateColumn} <= ?`; args.push(to) }
  }
  for (const filter of def.filters ?? []) {
    const raw = (params.get(`f_${filter.dim}`) || "").trim()
    if (!raw) continue
    if (filter.match === "eq") {
      injected += ` AND ${filter.column} = ?`
      args.push(raw)
    } else {
      injected += ` AND ${filter.column} LIKE ?`
      args.push(`%${raw}%`)
    }
  }
  const sql = def.sql.replaceAll("{{range}}", injected)

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

  return NextResponse.json({ report: reportMeta, rows, available })
}
