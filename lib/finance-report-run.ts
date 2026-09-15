import "server-only"
import { query } from "@/lib/db"
import { getSettings } from "@/lib/settings/server"
import {
  FINANCE_ONLY_REPORT_MAP,
  FILTER_DIM_LABELS,
  type ReportDef,
} from "@/lib/finance-reports"

/**
 * Single execution engine for every Financial Report. Both the reports GET
 * route (interactive viewer) and the report email route run through here so
 * there is exactly one place that turns a report key + period + filters into
 * rows — no duplicate query logic. Each run is defensive: a missing source
 * table/column yields an empty, `available: false` result instead of a 500.
 */

export type ReportRunColumn = {
  key: string
  label: string
  align?: "left" | "right"
  money?: boolean
}

export type ReportRunMeta = {
  key: string
  label: string
  group: string
  description: string
  columns: ReportRunColumn[]
  hasDateFilter: boolean
  periodMode: ReportDef["periodMode"] | "range" | "none"
  filters: { dim: string; label: string }[]
}

export type ReportRunResult = {
  ok: boolean
  status: number
  reportMeta?: ReportRunMeta
  rows: Record<string, any>[]
  available: boolean
  error?: string
}

export type ReportCompany = {
  name: string
  addressLines: string[]
  email: string
  phone: string
  website: string
  taxLabel: string
  taxNumber: string
}

/** Serialise a report's declared filters into the { dim, label } UI shape. */
export function reportFilterMeta(def: ReportDef) {
  return (def.filters ?? []).map((f) => ({ dim: f.dim, label: FILTER_DIM_LABELS[f.dim] }))
}

export function buildReportMeta(def: ReportDef): ReportRunMeta {
  return {
    key: def.key,
    label: def.label,
    group: def.group,
    description: def.description,
    columns: def.columns as ReportRunColumn[],
    hasDateFilter: !!def.dateColumn,
    periodMode: def.periodMode ?? (def.dateColumn ? "range" : "none"),
    filters: reportFilterMeta(def),
  }
}

export type RunReportInput = {
  reportKey: string
  from?: string
  to?: string
  /** Active dimension filters keyed by their `dim`. */
  filters?: Record<string, string>
}

/**
 * Resolve, bind and run one report. Mirrors the binding order the route has
 * always used: date range first, then each declared dimension filter, so the
 * pushed args line up with the spliced WHERE fragments.
 */
export async function runFinanceReport(input: RunReportInput): Promise<ReportRunResult> {
  const def = FINANCE_ONLY_REPORT_MAP[input.reportKey]
  if (!def) return { ok: false, status: 404, rows: [], available: false, error: "Unknown report" }

  const reportMeta = buildReportMeta(def)

  // Placeholder reports have no query yet — surface an empty, unavailable result.
  if (!def.sql) {
    return { ok: true, status: 200, reportMeta, rows: [], available: false }
  }

  const args: any[] = []
  let injected = ""
  if (def.dateColumn) {
    if (input.from) {
      injected += ` AND ${def.dateColumn} >= ?`
      args.push(input.from)
    }
    if (input.to) {
      injected += ` AND ${def.dateColumn} <= ?`
      args.push(input.to)
    }
  }
  for (const filter of def.filters ?? []) {
    const raw = (input.filters?.[filter.dim] || "").trim()
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

  try {
    const rows = (await query(sql, args)) as any[]
    return { ok: true, status: 200, reportMeta, rows, available: true }
  } catch (err) {
    console.log("[v0] report query failed for", input.reportKey, (err as Error).message)
    return { ok: true, status: 200, reportMeta, rows: [], available: false }
  }
}

/**
 * Company identity block for report letterheads (View dialog, PDF, email).
 * Reads the same company_settings keys the invoice PDF uses so every finance
 * document presents one consistent letterhead.
 */
export async function getReportCompany(): Promise<ReportCompany> {
  let s: Record<string, string> = {}
  try {
    s = (await getSettings()) as Record<string, string>
  } catch {
    s = {}
  }
  const addressLines = [
    s["address.line"] || "",
    [s["address.city"], s["address.state"], s["address.postal_code"]].filter(Boolean).join(", "),
    s["address.country"] || "",
  ].filter(Boolean)
  return {
    name: s["company.name"] || "Company",
    addressLines,
    email: s["company.email"] || "",
    phone: s["company.phone"] || "",
    website: s["company.website"] || "",
    taxLabel: s["tax.number_label"] || s["address.tax_name"] || "GSTIN",
    taxNumber: s["address.tax_number"] || "",
  }
}
