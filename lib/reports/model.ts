/**
 * Custom Report Builder — pure model (DB-free, testable, client-shareable).
 * ---------------------------------------------------------------------------
 * The report DEFINITION shape plus every piece of logic that does not need the
 * database: the operator / aggregation vocabularies and which of them a given
 * column TYPE permits, the date-range presets and their resolution to a
 * [from, to) window, hard safety caps, and `validateReportDefinition` — the
 * single gate that turns arbitrary client JSON into a normalized, allowlisted
 * definition or a list of errors.
 *
 * Carries no `server-only` / Node / DB import so it is unit-testable and shared
 * (type + validation) with the UI. The server query compiler
 * (lib/reports/query-builder.ts) consumes only the normalized output of
 * `validateReportDefinition`, so a value that reaches SQL has already been
 * checked against the catalog here.
 */
import type { ReportColumnType, ReportSource } from "@/lib/reports/catalog"

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const FILTER_OPERATORS = [
  "eq",
  "neq",
  "contains",
  "starts_with",
  "ends_with",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in",
  "before",
  "after",
  "is_empty",
  "is_not_empty",
] as const
export type FilterOperator = (typeof FILTER_OPERATORS)[number]

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: "equals",
  neq: "does not equal",
  contains: "contains",
  starts_with: "starts with",
  ends_with: "ends with",
  gt: "greater than",
  gte: "greater than or equal",
  lt: "less than",
  lte: "less than or equal",
  between: "between",
  in: "is any of",
  before: "before",
  after: "after",
  is_empty: "is empty",
  is_not_empty: "is not empty",
}

/** Operators offered for each column type. */
export function operatorsForType(type: ReportColumnType): FilterOperator[] {
  switch (type) {
    case "number":
      return ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "is_empty", "is_not_empty"]
    case "date":
    case "datetime":
      return ["eq", "before", "after", "between", "is_empty", "is_not_empty"]
    case "boolean":
      return ["eq", "is_empty", "is_not_empty"]
    case "string":
    default:
      return ["eq", "neq", "contains", "starts_with", "ends_with", "in", "is_empty", "is_not_empty"]
  }
}

/** Operators that need no value at all. */
export const VALUELESS_OPERATORS: FilterOperator[] = ["is_empty", "is_not_empty"]
/** Operators that need a second value. */
export const RANGE_OPERATORS: FilterOperator[] = ["between"]

export const AGGREGATIONS = ["sum", "avg", "min", "max", "count", "count_distinct"] as const
export type Aggregation = (typeof AGGREGATIONS)[number]

export const AGGREGATION_LABELS: Record<Aggregation, string> = {
  sum: "Sum",
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
  count: "Count",
  count_distinct: "Distinct count",
}

/** Aggregations that make sense for a column type. */
export function aggregationsForType(type: ReportColumnType): Aggregation[] {
  if (type === "number") return ["sum", "avg", "min", "max", "count", "count_distinct"]
  if (type === "date" || type === "datetime") return ["min", "max", "count", "count_distinct"]
  return ["count", "count_distinct"]
}

// ---------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------

export const DATE_RANGE_PRESETS = [
  "today",
  "yesterday",
  "last_7_days",
  "last_30_days",
  "this_month",
  "last_month",
  "this_quarter",
  "this_year",
  "last_year",
  "custom",
] as const
export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number]

export const DATE_RANGE_LABELS: Record<DateRangePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  this_month: "This month",
  last_month: "Last month",
  this_quarter: "This quarter",
  this_year: "This year",
  last_year: "Last year",
  custom: "Custom range",
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Resolve a preset to a `[from, toExclusive)` window of ISO date strings.
 * `custom` requires from/to. Returns null when the range cannot be resolved
 * (e.g. custom without dates), so the caller can skip an invalid range.
 */
export function resolveDateRange(
  preset: DateRangePreset,
  custom: { from?: string | null; to?: string | null } = {},
  now: Date = new Date(),
): { from: string; toExclusive: string } | null {
  const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)
  const today = startOfDay(now)

  switch (preset) {
    case "today":
      return { from: isoDate(today), toExclusive: isoDate(addDays(today, 1)) }
    case "yesterday":
      return { from: isoDate(addDays(today, -1)), toExclusive: isoDate(today) }
    case "last_7_days":
      return { from: isoDate(addDays(today, -6)), toExclusive: isoDate(addDays(today, 1)) }
    case "last_30_days":
      return { from: isoDate(addDays(today, -29)), toExclusive: isoDate(addDays(today, 1)) }
    case "this_month": {
      const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
      const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1))
      return { from: isoDate(from), toExclusive: isoDate(to) }
    }
    case "last_month": {
      const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))
      const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
      return { from: isoDate(from), toExclusive: isoDate(to) }
    }
    case "this_quarter": {
      const q = Math.floor(today.getUTCMonth() / 3)
      const from = new Date(Date.UTC(today.getUTCFullYear(), q * 3, 1))
      const to = new Date(Date.UTC(today.getUTCFullYear(), q * 3 + 3, 1))
      return { from: isoDate(from), toExclusive: isoDate(to) }
    }
    case "this_year": {
      const from = new Date(Date.UTC(today.getUTCFullYear(), 0, 1))
      const to = new Date(Date.UTC(today.getUTCFullYear() + 1, 0, 1))
      return { from: isoDate(from), toExclusive: isoDate(to) }
    }
    case "last_year": {
      const from = new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1))
      const to = new Date(Date.UTC(today.getUTCFullYear(), 0, 1))
      return { from: isoDate(from), toExclusive: isoDate(to) }
    }
    case "custom": {
      if (!custom.from || !custom.to) return null
      const from = new Date(custom.from)
      const to = new Date(custom.to)
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null
      // `to` is inclusive from the UI, so make the window end exclusive at the next day.
      return { from: isoDate(startOfDay(from)), toExclusive: isoDate(addDays(startOfDay(to), 1)) }
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Definition shape
// ---------------------------------------------------------------------------

export type SelectedColumn = {
  column: string
  /** When set, the column is a calculation (aggregate) rather than a raw value. */
  aggregation?: Aggregation | null
}

export type ReportFilter = {
  column: string
  operator: FilterOperator
  value?: string | null
  value2?: string | null
}

export type ReportSortItem = {
  column: string
  aggregation?: Aggregation | null
  direction: "asc" | "desc"
}

export type ReportDateRange = {
  column: string
  preset: DateRangePreset
  from?: string | null
  to?: string | null
}

export type ReportDefinition = {
  sourceKey: string
  columns: SelectedColumn[]
  filters: ReportFilter[]
  groupBy: string[]
  sort: ReportSortItem[]
  dateRange?: ReportDateRange | null
  limit?: number | null
}

// ---------------------------------------------------------------------------
// Safety caps
// ---------------------------------------------------------------------------

export const REPORT_CAPS = {
  maxColumns: 30,
  maxFilters: 20,
  maxGroupBy: 6,
  maxSort: 4,
  /** Hard ceiling on returned rows regardless of a requested limit. */
  maxRows: 10_000,
  /** Default page size for interactive previews. */
  previewRows: 500,
} as const

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { ok: true; definition: ReportDefinition }
  | { ok: false; errors: string[] }

const IDENTIFIER_RE = /^[a-z0-9_]+$/

/**
 * Validate + normalize an untrusted definition against a source's catalog.
 * Every column reference is checked against the source's whitelisted columns;
 * operators / aggregations are checked against what the column type permits.
 * The result is safe to hand to the query compiler.
 *
 * `availableColumnKeys` is the set of catalog columns that also exist in the
 * live schema; when provided, references to catalog columns absent from the
 * deployment are rejected too.
 */
export function validateReportDefinition(
  source: ReportSource,
  raw: unknown,
  availableColumnKeys?: Set<string>,
): ValidationResult {
  const errors: string[] = []
  const def = (raw ?? {}) as Partial<ReportDefinition>

  const byKey = new Map(source.columns.map((c) => [c.key, c]))
  const isAvailable = (key: string) =>
    byKey.has(key) && IDENTIFIER_RE.test(key) && (!availableColumnKeys || availableColumnKeys.has(key))

  // --- columns -------------------------------------------------------------
  const rawColumns = Array.isArray(def.columns) ? def.columns : []
  if (rawColumns.length === 0) errors.push("Select at least one column.")
  if (rawColumns.length > REPORT_CAPS.maxColumns)
    errors.push(`Too many columns (max ${REPORT_CAPS.maxColumns}).`)

  const columns: SelectedColumn[] = []
  for (const c of rawColumns.slice(0, REPORT_CAPS.maxColumns)) {
    const key = String((c as SelectedColumn)?.column ?? "")
    if (!isAvailable(key)) {
      errors.push(`Unknown column "${key}".`)
      continue
    }
    const meta = byKey.get(key)!
    let aggregation: Aggregation | null = null
    const rawAgg = (c as SelectedColumn)?.aggregation
    if (rawAgg) {
      if (!aggregationsForType(meta.type).includes(rawAgg as Aggregation)) {
        errors.push(`Aggregation "${rawAgg}" is not allowed on "${meta.label}".`)
      } else {
        aggregation = rawAgg as Aggregation
      }
    }
    columns.push({ column: key, aggregation })
  }

  const aggregated = columns.filter((c) => c.aggregation)
  const plain = columns.filter((c) => !c.aggregation)

  // --- group by ------------------------------------------------------------
  const rawGroup = Array.isArray(def.groupBy) ? def.groupBy : []
  if (rawGroup.length > REPORT_CAPS.maxGroupBy)
    errors.push(`Too many grouping columns (max ${REPORT_CAPS.maxGroupBy}).`)
  const groupBy: string[] = []
  for (const g of rawGroup.slice(0, REPORT_CAPS.maxGroupBy)) {
    const key = String(g)
    if (!isAvailable(key)) {
      errors.push(`Unknown grouping column "${key}".`)
      continue
    }
    if (!groupBy.includes(key)) groupBy.push(key)
  }

  // Aggregation ⇒ grouping consistency (protects against only_full_group_by
  // errors and nonsensical mixed selects).
  if (aggregated.length > 0) {
    for (const p of plain) {
      if (!groupBy.includes(p.column)) {
        errors.push(`Column "${byKey.get(p.column)?.label ?? p.column}" must be grouped or aggregated.`)
      }
    }
  } else if (groupBy.length > 0) {
    errors.push("Grouping requires at least one aggregated (calculation) column.")
  }

  // --- filters -------------------------------------------------------------
  const rawFilters = Array.isArray(def.filters) ? def.filters : []
  if (rawFilters.length > REPORT_CAPS.maxFilters)
    errors.push(`Too many filters (max ${REPORT_CAPS.maxFilters}).`)
  const filters: ReportFilter[] = []
  for (const f of rawFilters.slice(0, REPORT_CAPS.maxFilters)) {
    const key = String((f as ReportFilter)?.column ?? "")
    if (!isAvailable(key)) {
      errors.push(`Unknown filter column "${key}".`)
      continue
    }
    const meta = byKey.get(key)!
    const operator = (f as ReportFilter)?.operator
    if (!operatorsForType(meta.type).includes(operator as FilterOperator)) {
      errors.push(`Operator "${operator}" is not allowed on "${meta.label}".`)
      continue
    }
    const op = operator as FilterOperator
    const value = (f as ReportFilter)?.value ?? null
    const value2 = (f as ReportFilter)?.value2 ?? null
    if (!VALUELESS_OPERATORS.includes(op)) {
      if (value === null || value === "") {
        errors.push(`Filter on "${meta.label}" needs a value.`)
        continue
      }
      if (RANGE_OPERATORS.includes(op) && (value2 === null || value2 === "")) {
        errors.push(`Filter on "${meta.label}" needs a second value.`)
        continue
      }
    }
    filters.push({ column: key, operator: op, value, value2 })
  }

  // --- sort ----------------------------------------------------------------
  const rawSort = Array.isArray(def.sort) ? def.sort : []
  if (rawSort.length > REPORT_CAPS.maxSort) errors.push(`Too many sort columns (max ${REPORT_CAPS.maxSort}).`)
  const selectedKey = (c: SelectedColumn) => `${c.column}::${c.aggregation ?? ""}`
  const selectedSet = new Set(columns.map(selectedKey))
  const sort: ReportSortItem[] = []
  for (const s of rawSort.slice(0, REPORT_CAPS.maxSort)) {
    const key = String((s as ReportSortItem)?.column ?? "")
    const agg = ((s as ReportSortItem)?.aggregation ?? null) as Aggregation | null
    if (!isAvailable(key)) {
      errors.push(`Unknown sort column "${key}".`)
      continue
    }
    // A sort must target one of the selected output columns.
    if (!selectedSet.has(`${key}::${agg ?? ""}`)) {
      errors.push(`Sort column "${byKey.get(key)?.label ?? key}" must also be a selected column.`)
      continue
    }
    const direction = (s as ReportSortItem)?.direction === "desc" ? "desc" : "asc"
    sort.push({ column: key, aggregation: agg, direction })
  }

  // --- date range ----------------------------------------------------------
  let dateRange: ReportDateRange | null = null
  if (def.dateRange && (def.dateRange as ReportDateRange).column) {
    const dr = def.dateRange as ReportDateRange
    const key = String(dr.column)
    const meta = byKey.get(key)
    if (!isAvailable(key) || !meta || (meta.type !== "date" && meta.type !== "datetime")) {
      errors.push(`Invalid date-range column "${key}".`)
    } else if (!DATE_RANGE_PRESETS.includes(dr.preset)) {
      errors.push(`Invalid date range preset "${dr.preset}".`)
    } else if (dr.preset === "custom" && (!dr.from || !dr.to)) {
      errors.push("Custom date range needs a start and end date.")
    } else {
      dateRange = { column: key, preset: dr.preset, from: dr.from ?? null, to: dr.to ?? null }
    }
  }

  // --- limit ---------------------------------------------------------------
  let limit: number | null = null
  if (def.limit != null) {
    const n = Math.trunc(Number(def.limit))
    if (Number.isFinite(n) && n > 0) limit = Math.min(n, REPORT_CAPS.maxRows)
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    definition: { sourceKey: source.key, columns, filters, groupBy, sort, dateRange, limit },
  }
}

/** Stable output alias for a selected column (used as the result key + header). */
export function columnAlias(c: SelectedColumn): string {
  return c.aggregation ? `${c.column}__${c.aggregation}` : c.column
}
