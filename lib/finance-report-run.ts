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
  type ReportSourceError,
  type SourceHealth,
} from "@/lib/finance-report-diagnostics"
import { getScope } from "@/lib/permission-store"
import { flattenStatement } from "@/lib/statement-export"
import {
  computeTrialBalance,
  computeProfitAndLoss,
  computeBalanceSheet,
  computeCashFlow,
} from "@/lib/finance-statements"

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
  pan: string
}

/** Serialise a report's declared filters into the { dim, label } UI shape. */
export function reportFilterMeta(def: ReportDef) {
  return (def.filters ?? []).map((f) => ({ dim: f.dim, label: FILTER_DIM_LABELS[f.dim] }))
}

// ---------------------------------------------------------------------------
// Report data security (Phase 33)
// ---------------------------------------------------------------------------
// A report may expose data that belongs to a specific finance sub-module. A
// user must be able to VIEW that module before they can see, run, export or
// email the report — otherwise a restricted domain (e.g. payroll-driven
// expenses) could leak through the reports hub. The requirement is derived
// from the report's primary source table so it stays correct as the catalogue
// grows, with an explicit override map for the few cross-table reports.
//
// Reports whose source is org-level ledger data (trial balance, P&L, balance
// sheet, journals) require only the base `finance.reports` view that every
// visitor to this page already holds, so they map to `null` (no extra gate).

const SOURCE_TABLE_MODULE: Record<string, string> = {
  expenses: "finance.expenses",
  purchase_bills: "finance.purchase_bills",
  sales_invoices: "finance.sales_invoices",
  bank_transactions: "finance.bank_transactions",
  finance_accounts: "finance.bank_cash",
  gst_filings: "finance.gst_filing",
  finance_gst_input: "finance.gst_filing",
  gstr2b: "finance.gst_filing",
  tds_filings: "finance.tds_filing",
}

/** Explicit per-report overrides where the source table is ambiguous. */
const REPORT_MODULE_OVERRIDE: Record<string, string | null> = {
  "ab-payment-register": "finance.expenses",
  "ab-receipt-register": "finance.sales_invoices",
}

/**
 * The finance module a user must be able to VIEW to access this report, or
 * `null` when only the base Financial Reports view is required.
 */
export function reportRequiredModule(def: ReportDef): string | null {
  if (def.key in REPORT_MODULE_OVERRIDE) return REPORT_MODULE_OVERRIDE[def.key]
  const table = def.sql?.match(/FROM\s+(\w+)/i)?.[1]?.toLowerCase()
  if (table && SOURCE_TABLE_MODULE[table]) return SOURCE_TABLE_MODULE[table]
  return null
}

export type ReportViewer = { userId: number; role: "admin" | "employee" }

/**
 * Whether `viewer` may access `def`. Admins always may; otherwise the viewer
 * needs a non-`none` view scope on the report's required module. Reports with
 * no module gate (`null`) are accessible to anyone who reached this page.
 */
export async function canAccessReport(viewer: ReportViewer, def: ReportDef): Promise<boolean> {
  if (viewer.role === "admin") return true
  const moduleKey = reportRequiredModule(def)
  if (!moduleKey) return true
  const scope = await getScope(viewer.userId, viewer.role, moduleKey, "view")
  return scope !== "none"
}

/** Filter a catalogue down to the reports a viewer is allowed to see. */
export async function filterAccessibleReports<T extends ReportDef>(
  viewer: ReportViewer,
  defs: T[],
): Promise<T[]> {
  if (viewer.role === "admin") return defs
  const verdicts = await Promise.all(defs.map((d) => canAccessReport(viewer, d)))
  return defs.filter((_, i) => verdicts[i])
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

  const diagnose = (
    rows: Record<string, any>[],
    available: boolean,
    health: SourceHealth,
    sourceError?: ReportSourceError,
  ) =>
    computeReportDiagnostics({
      columns: def.columns,
      rows,
      available,
      // A report is "sourced" when it has raw SQL OR is computed by the
      // classification statement engine (Trial Balance, P&L, Balance Sheet,
      // Cash Flow). Only reports with neither are genuine placeholders.
      hasSql: !!def.sql || !!def.statement,
      from: input.from,
      to: input.to,
      config: def.diagnostics,
      health,
      sourceError,
    })

  // Statement reports (Trial Balance, P&L, Balance Sheet, Cash Flow) carry no
  // raw SQL — they are computed by the classification-aware statement engine
  // and flattened through the SAME `flattenStatement` bridge the dedicated
  // Financial Statements page uses, so the reports hub reuses those exact
  // numbers rather than a second, naive ledger group-by (Phases 62-63).
  if (def.statement) {
    try {
      let data: any = null
      switch (def.statement) {
        case "trial-balance":
          data = await computeTrialBalance(input.to || null)
          break
        case "profit-loss":
          data = await computeProfitAndLoss(input.from || null, input.to || null)
          break
        case "balance-sheet":
          data = await computeBalanceSheet(input.to || null)
          break
        case "cash-flow":
          data = await computeCashFlow(input.from || null, input.to || null)
          break
      }
      const { rows } = flattenStatement(def.statement, data)
      return {
        ok: true,
        status: 200,
        reportMeta,
        rows,
        available: true,
        diagnostics: diagnose(rows, true, EMPTY_HEALTH),
      }
    } catch (err) {
      console.log("[v0] statement report failed for", input.reportKey, (err as Error).message)
      // Statement reports are computed from the Chart of Accounts + posted
      // General Ledger; classify the failure against those source tables so the
      // banner names the genuinely missing source (Phase 23) rather than
      // reporting a blanket "no data source".
      const sourceError = classifyDbError(err, ["chart_of_accounts", "general_ledger"], "General Ledger / Chart of Accounts")
      return {
        ok: true,
        status: 200,
        reportMeta,
        rows: [],
        available: false,
        diagnostics: diagnose([], false, EMPTY_HEALTH, sourceError),
      }
    }
  }

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
    // The report IS wired to a source — the failure is either a genuinely
    // missing table (needs setting up) or a broken query (needs fixing). Name
    // the report's own FROM table so the banner is specific (Phases 23/31).
    const tables = collectFromTables(def.sql ?? "")
    const sourceError = classifyDbError(err, tables, humaniseSource(tables[0]))
    return {
      ok: true,
      status: 200,
      reportMeta,
      rows: [],
      available: false,
      diagnostics: diagnose([], false, EMPTY_HEALTH, sourceError),
    }
  }
}

// ---------------------------------------------------------------------------
// DB error classification (Phases 23/31)
// ---------------------------------------------------------------------------
// Turn a raw mysql2 error into an actionable verdict: a genuinely missing
// source table ("Required source is not available") versus a query that
// references a column the (existing) source no longer has ("query needs
// updating") versus any other failure. The raw reason is always carried
// through for on-screen + log debugging so nothing fails silently.

/** Every table named after a FROM / JOIN in a report's SQL. */
function collectFromTables(sql: string): string[] {
  const tables: string[] = []
  const re = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) {
    const t = m[1].toLowerCase()
    // Skip the derived-subquery alias `x`/`t` and duplicates.
    if (t.length > 2 && !tables.includes(t)) tables.push(t)
  }
  return tables
}

/** Turn a snake_case table name into a readable source label. */
function humaniseSource(table?: string): string | undefined {
  if (!table) return undefined
  return table
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function classifyDbError(err: unknown, candidateTables: string[], sourceLabel?: string): ReportSourceError {
  const code = (err as { code?: string })?.code || ""
  const detail = (err as Error)?.message || String(err)

  // A missing table means the source module has not been set up yet.
  if (code === "ER_NO_SUCH_TABLE" || /doesn't exist|Table '.*' doesn't/i.test(detail)) {
    // Prefer the specific table named in the DB error, else the first FROM table.
    const named = detail.match(/Table '(?:[^.']*\.)?([^']+)'/i)?.[1]
    const missing = named || candidateTables[0]
    return { kind: "missing", source: humaniseSource(missing) || sourceLabel, detail }
  }

  // A bad field / unknown column means the source exists but the query drifted.
  if (code === "ER_BAD_FIELD_ERROR" || /Unknown column/i.test(detail)) {
    return { kind: "broken", source: sourceLabel, detail }
  }

  return { kind: "unknown", source: sourceLabel, detail }
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
    // PAN is either configured directly or derived from a 15-char GSTIN
    // (characters 3-12 are the PAN), mirroring the invoice PDF letterhead.
    pan: s["tax.pan"] || derivePanFromGstin(s["address.tax_number"] || ""),
  }
}

/** GSTIN embeds the PAN at positions 3-12 (e.g. 27ABCDE1234F1Z5 → ABCDE1234F). */
function derivePanFromGstin(gstin: string): string {
  const g = gstin.trim().toUpperCase()
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]{2}$/.test(g)) return ""
  return g.slice(2, 12)
}
