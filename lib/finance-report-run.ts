import "server-only"
import { query } from "@/lib/db"
import { getSettings } from "@/lib/settings/server"
import {
  FINANCE_ONLY_REPORT_MAP,
  FILTER_DIM_LABELS,
  type ReportDef,
} from "@/lib/finance-reports"
import {
  computeReportDiagnostics,
  EMPTY_HEALTH,
  type ReportDiagnostics,
  type SourceHealth,
} from "@/lib/finance-report-diagnostics"

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
  /** Phase 21-25 source-health + reconciliation verdict for this run. */
  diagnostics?: ReportDiagnostics
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

  const diagnose = (rows: Record<string, any>[], available: boolean, health: SourceHealth) =>
    computeReportDiagnostics({
      columns: def.columns,
      rows,
      available,
      hasSql: !!def.sql,
      from: input.from,
      to: input.to,
      config: def.diagnostics,
      health,
    })

  // Placeholder reports have no query yet — surface an empty, unavailable
  // result with an explicit "no data source configured" verdict (Phase 24).
  if (!def.sql) {
    return {
      ok: true,
      status: 200,
      reportMeta,
      rows: [],
      available: false,
      diagnostics: diagnose([], false, EMPTY_HEALTH),
    }
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
    const health = await gatherSourceHealth(def.diagnostics?.requires ?? [], input.from, input.to)
    return { ok: true, status: 200, reportMeta, rows, available: true, diagnostics: diagnose(rows, true, health) }
  } catch (err) {
    console.log("[v0] report query failed for", input.reportKey, (err as Error).message)
    return { ok: true, status: 200, reportMeta, rows: [], available: false, diagnostics: diagnose([], false, EMPTY_HEALTH) }
  }
}

/**
 * Gather the posted-ledger / source health signals a report's reconciliation
 * rules need, scoped to the run's period. Only the signals a report actually
 * declares in `diagnostics.requires` are queried, and every probe is defensive:
 * a missing table or column yields a `null` signal (which the diagnostics layer
 * treats as "unknown", never as a false zero) instead of failing the run.
 */
async function gatherSourceHealth(
  requires: NonNullable<ReportDef["diagnostics"]>["requires"] = [],
  from?: string,
  to?: string,
): Promise<SourceHealth> {
  const need = new Set(requires ?? [])
  if (need.size === 0) return EMPTY_HEALTH
  const health: SourceHealth = { ...EMPTY_HEALTH }

  const range = (col: string) => {
    const parts: string[] = []
    const args: any[] = []
    if (from) {
      parts.push(`AND ${col} >= ?`)
      args.push(from)
    }
    if (to) {
      parts.push(`AND ${col} <= ?`)
      args.push(to)
    }
    return { clause: parts.join(" "), args }
  }

  if (need.has("posting")) {
    try {
      const r = range("journal_date")
      const rows = (await query(
        `SELECT COUNT(*) AS cnt,
                COALESCE(SUM(GREATEST(COALESCE(debit,0), COALESCE(credit,0))),0) AS val
           FROM journal_entries
          WHERE COALESCE(NULLIF(posting_status,''),'Unposted') <> 'Posted'
            AND COALESCE(NULLIF(approval_status,''),'Pending') NOT IN ('Rejected','Cancelled') ${r.clause}`,
        r.args,
      )) as any[]
      health.unpostedCount = Number(rows?.[0]?.cnt ?? 0)
      health.unpostedValue = Number(rows?.[0]?.val ?? 0)
    } catch (err) {
      console.log("[v0] source health (posting) probe failed:", (err as Error).message)
    }
  }

  if (need.has("coaMapping")) {
    try {
      const rows = (await query(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN NULLIF(TRIM(account_type),'') IS NULL THEN 1 ELSE 0 END) AS unmapped
           FROM chart_of_accounts`,
      )) as any[]
      health.coaTotal = Number(rows?.[0]?.total ?? 0)
      health.coaUnmapped = Number(rows?.[0]?.unmapped ?? 0)
    } catch (err) {
      console.log("[v0] source health (coaMapping) probe failed:", (err as Error).message)
    }
  }

  if (need.has("earnings")) {
    try {
      const r = range("transaction_date")
      const rows = (await query(
        `SELECT COALESCE(SUM(CASE WHEN account_type LIKE '%Income%' OR account_type LIKE '%Revenue%'
                                  THEN credit - debit ELSE 0 END),0)
              - COALESCE(SUM(CASE WHEN account_type LIKE '%Expense%' OR account_type LIKE '%Cost%'
                                  THEN debit - credit ELSE 0 END),0) AS net
           FROM general_ledger WHERE 1=1 ${r.clause}`,
        r.args,
      )) as any[]
      health.glNetEarnings = Number(rows?.[0]?.net ?? 0)
    } catch (err) {
      console.log("[v0] source health (earnings) probe failed:", (err as Error).message)
    }
  }

  if (need.has("bank")) {
    try {
      const r = range("transaction_date")
      const rows = (await query(
        `SELECT COALESCE(SUM(credit),0) - COALESCE(SUM(debit),0) AS net
           FROM bank_transactions WHERE 1=1 ${r.clause}`,
        r.args,
      )) as any[]
      health.bankNet = Number(rows?.[0]?.net ?? 0)
    } catch (err) {
      console.log("[v0] source health (bank) probe failed:", (err as Error).message)
    }
  }

  return health
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
