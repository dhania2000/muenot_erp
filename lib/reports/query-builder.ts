import "server-only"
/**
 * Custom Report Builder — safe query compiler + engine.
 * ---------------------------------------------------------------------------
 * The ONLY place a report definition becomes SQL. It is safe by construction:
 *
 *   1. The source key + every column reference is re-resolved against the
 *      catalog AND the LIVE schema (lib/db#tableColumns). Anything not present
 *      is rejected — nothing from the client picks a table or column name.
 *   2. Physical identifiers are additionally regex-checked and backticked; the
 *      identifier set can only ever be catalog columns that exist for real.
 *   3. Every VALUE is parameterized (`?`), never interpolated.
 *   4. A `tenant_id = ?` predicate is ALWAYS emitted when a tenant is in
 *      context (satisfying lib/tenant-guard.ts); if the table is tenant-scoped
 *      but no tenant column can be resolved, the query is REFUSED rather than
 *      risk a cross-tenant read.
 *   5. Hard caps (LIMIT, column/filter/group counts) bound cost so a report can
 *      never become an unbounded, expensive scan.
 *   6. Raw rows are run through the data-classification redactor so a report
 *      can never surface a field the acting role may not see.
 */
import { query, tableColumns } from "@/lib/db"
import { getReportSource, type ReportSource } from "@/lib/reports/catalog"
import {
  columnAlias,
  resolveDateRange,
  REPORT_CAPS,
  validateReportDefinition,
  type Aggregation,
  type ReportDefinition,
  type ReportFilter,
} from "@/lib/reports/model"
import type { TenantRole } from "@/lib/role-model"
import { resolveExistingColumn } from "@/lib/data-export-catalog"
import { buildReportScope, enforceReportSecurity, resolveReportActor } from "@/lib/reports/authorization"
import type { DataScopeSql } from "@/lib/data-scope-model"

const IDENTIFIER_RE = /^[a-z0-9_]+$/

/** Backtick-quote an identifier, throwing if it is not a bare column name. */
function ident(name: string): string {
  if (!IDENTIFIER_RE.test(name)) throw new Error(`Unsafe identifier: ${name}`)
  return `\`${name}\``
}

/** Map a validated aggregation onto a SQL expression over an already-safe identifier. */
function aggExpr(agg: Aggregation, colSql: string): string {
  switch (agg) {
    case "sum":
      return `SUM(${colSql})`
    case "avg":
      return `AVG(${colSql})`
    case "min":
      return `MIN(${colSql})`
    case "max":
      return `MAX(${colSql})`
    case "count":
      return `COUNT(${colSql})`
    case "count_distinct":
      return `COUNT(DISTINCT ${colSql})`
    default:
      throw new Error(`Unsupported aggregation: ${agg}`)
  }
}

/** Build one filter's SQL fragment + params. Values are always parameterized. */
function compileFilter(f: ReportFilter): { sql: string; params: unknown[] } {
  const c = ident(f.column)
  switch (f.operator) {
    case "eq":
      return { sql: `${c} = ?`, params: [f.value] }
    case "neq":
      return { sql: `${c} <> ?`, params: [f.value] }
    case "contains":
      return { sql: `${c} LIKE ?`, params: [`%${escapeLike(String(f.value))}%`] }
    case "starts_with":
      return { sql: `${c} LIKE ?`, params: [`${escapeLike(String(f.value))}%`] }
    case "ends_with":
      return { sql: `${c} LIKE ?`, params: [`%${escapeLike(String(f.value))}`] }
    case "gt":
      return { sql: `${c} > ?`, params: [f.value] }
    case "gte":
      return { sql: `${c} >= ?`, params: [f.value] }
    case "lt":
      return { sql: `${c} < ?`, params: [f.value] }
    case "lte":
      return { sql: `${c} <= ?`, params: [f.value] }
    case "before":
      return { sql: `${c} < ?`, params: [f.value] }
    case "after":
      return { sql: `${c} > ?`, params: [f.value] }
    case "between":
      return { sql: `${c} BETWEEN ? AND ?`, params: [f.value, f.value2] }
    case "in": {
      const parts = String(f.value ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      if (parts.length === 0) return { sql: "1=1", params: [] }
      return { sql: `${c} IN (${parts.map(() => "?").join(", ")})`, params: parts }
    }
    case "is_empty":
      return { sql: `(${c} IS NULL OR ${c} = '')`, params: [] }
    case "is_not_empty":
      return { sql: `(${c} IS NOT NULL AND ${c} <> '')`, params: [] }
    default:
      throw new Error(`Unsupported operator: ${f.operator}`)
  }
}

/** Escape LIKE wildcards in user input so `%`/`_` are treated literally. */
function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (m) => `\\${m}`)
}

export type CompiledQuery = {
  sql: string
  params: unknown[]
  /** Output column keys in select order. */
  aliases: string[]
  /** Header label per alias. */
  headers: Record<string, string>
  isAggregated: boolean
}

/**
 * Compile a validated definition into a single parameterized statement, scoped
 * to `tenantId`. `existing` is the live column set of the source's table.
 */
function compile(
  source: ReportSource,
  def: ReportDefinition,
  tenantId: number | null,
  existing: Set<string>,
  scope: DataScopeSql | null,
): CompiledQuery {
  const tenantCol = resolveExistingColumn(source.tenantColumns, existing)
  if (tenantId != null && !tenantCol) {
    // The table exists but we cannot find a tenant discriminator: refuse.
    throw new Error("This data source cannot be safely scoped to your tenant.")
  }

  const byKey = new Map(source.columns.map((c) => [c.key, c]))
  const selectParts: string[] = []
  const aliases: string[] = []
  const headers: Record<string, string> = {}

  for (const sel of def.columns) {
    const meta = byKey.get(sel.column)!
    const colSql = ident(sel.column)
    const alias = columnAlias(sel)
    const aliasSql = ident(alias)
    if (sel.aggregation) {
      selectParts.push(`${aggExpr(sel.aggregation, colSql)} AS ${aliasSql}`)
      headers[alias] = `${meta.label} (${sel.aggregation})`
    } else {
      selectParts.push(`${colSql} AS ${aliasSql}`)
      headers[alias] = meta.label
    }
    aliases.push(alias)
  }

  const where: string[] = []
  const params: unknown[] = []

  if (tenantCol) {
    where.push(`${ident(tenantCol)} = ?`)
    params.push(tenantId)
  }

  // SPEC 99 — row-level access control (User / Team / Entity / Branch). The
  // predicate is pre-built against the live schema and fails CLOSED ("1=0")
  // when a relational scope is misconfigured, so it can only ever hide rows.
  if (scope && scope.sql) {
    where.push(scope.sql)
    params.push(...scope.params)
  }

  for (const f of def.filters) {
    const { sql, params: fp } = compileFilter(f)
    where.push(sql)
    params.push(...fp)
  }

  if (def.dateRange) {
    const resolved = resolveDateRange(def.dateRange.preset, { from: def.dateRange.from, to: def.dateRange.to })
    if (resolved) {
      const c = ident(def.dateRange.column)
      where.push(`${c} >= ? AND ${c} < ?`)
      params.push(resolved.from, resolved.toExclusive)
    }
  }

  const isAggregated = def.columns.some((c) => c.aggregation)

  let groupSql = ""
  if (def.groupBy.length > 0) {
    groupSql = ` GROUP BY ${def.groupBy.map(ident).join(", ")}`
  }

  let orderSql = ""
  if (def.sort.length > 0) {
    const parts = def.sort.map((s) => {
      const alias = columnAlias({ column: s.column, aggregation: s.aggregation ?? null })
      return `${ident(alias)} ${s.direction === "desc" ? "DESC" : "ASC"}`
    })
    orderSql = ` ORDER BY ${parts.join(", ")}`
  }

  const limit = Math.min(def.limit ?? REPORT_CAPS.maxRows, REPORT_CAPS.maxRows)
  const limitSql = ` LIMIT ${Math.trunc(limit)}`

  const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
  const sql = `SELECT ${selectParts.join(", ")} FROM ${ident(source.table)}${whereSql}${groupSql}${orderSql}${limitSql}`

  return { sql, params, aliases, headers, isAggregated }
}

export type RunReportResult = {
  columns: { key: string; label: string }[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  redactedFields: string[]
  /** Fields masked/hidden by field-level security (SPEC 99). */
  maskedFields: string[]
  aggregated: boolean
}

export type RunOptions = {
  tenantId: number | null
  role: TenantRole
  /**
   * The acting user's id, used to resolve their data scope (User / Team /
   * Entity / Branch) and attribute policies. Omit / 0 for system contexts,
   * which resolve to no relational restriction.
   */
  userId?: number
  /** Permission groups the actor belongs to (field-level security scope). */
  permissionGroups?: string[]
  /** Override the definition's limit (e.g. a smaller preview cap). */
  limitOverride?: number
}

/**
 * Validate → compile → execute a report definition. Returns rows plus metadata.
 * Raw (non-aggregated) results are redacted per the acting role's clearance so
 * a report can never expose a classified field the role may not view.
 */
export async function runReport(rawDefinition: unknown, opts: RunOptions): Promise<RunReportResult> {
  const sourceKey = String((rawDefinition as ReportDefinition)?.sourceKey ?? "")
  const source = getReportSource(sourceKey)
  if (!source) throw new Error("Unknown data source.")

  const existing = await tableColumns(source.table).catch(() => new Set<string>())
  if (existing.size === 0) throw new Error("This data source is not available in this deployment.")

  const availableKeys = new Set(source.columns.filter((c) => existing.has(c.key.toLowerCase())).map((c) => c.key))
  const validated = validateReportDefinition(source, rawDefinition, availableKeys)
  if (!validated.ok) throw new ReportValidationError(validated.errors)

  const def = validated.definition
  if (opts.limitOverride != null) {
    def.limit = Math.min(opts.limitOverride, def.limit ?? REPORT_CAPS.maxRows, REPORT_CAPS.maxRows)
  }

  // SPEC 99 — resolve the acting user's full authorization context and build
  // the row-visibility predicate BEFORE compiling, so scope is enforced in SQL.
  const actor = await resolveReportActor({
    userId: opts.userId ?? 0,
    tenantId: opts.tenantId,
    role: opts.role,
    permissionGroups: opts.permissionGroups,
  })
  const scope = await buildReportScope(source, actor, existing)

  const compiled = compile(source, def, opts.tenantId, existing, scope)
  const rows = await query<Record<string, unknown>[]>(compiled.sql, compiled.params)

  // SPEC 99 — field-level protection (Role × Classification, then field-level
  // security). Aggregated outputs pass through untouched inside the enforcer.
  const enforced = await enforceReportSecurity(rows, {
    source,
    actor,
    isAggregated: compiled.isAggregated,
  })
  const finalRows = enforced.rows as Record<string, unknown>[]

  const limit = Math.min(def.limit ?? REPORT_CAPS.maxRows, REPORT_CAPS.maxRows)
  return {
    columns: compiled.aliases.map((a) => ({ key: a, label: compiled.headers[a] ?? a })),
    rows: finalRows,
    rowCount: finalRows.length,
    truncated: finalRows.length >= limit,
    redactedFields: enforced.redactedFields,
    maskedFields: enforced.maskedFields,
    aggregated: compiled.isAggregated,
  }
}

export class ReportValidationError extends Error {
  errors: string[]
  constructor(errors: string[]) {
    super(errors[0] ?? "Invalid report definition")
    this.name = "ReportValidationError"
    this.errors = errors
  }
}

/**
 * Resolve the public, deployment-accurate column list for one source: catalog
 * columns intersected with the live schema. Used by the API to advertise only
 * columns that actually exist.
 */
export async function resolveSourceColumns(source: ReportSource): Promise<Set<string>> {
  const existing = await tableColumns(source.table).catch(() => new Set<string>())
  return new Set(source.columns.filter((c) => existing.has(c.key.toLowerCase())).map((c) => c.key))
}
