/**
 * Saved Views: config sanitizer (single source of truth).
 *
 * Both the write path (API routes accepting untrusted client JSON) and the read
 * path (store parsing whatever is stored in the DB JSON column) MUST converge on
 * the same shape and the same hard caps, so a view can never carry unbounded or
 * malformed presentation state. Keeping this pure and server-free lets the API
 * routes, the store and the unit tests all share one implementation.
 */
import type { ColumnPref, SortRule, TableViewConfig } from "./types"
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from "./types"

const MAX_COLUMNS = 200
const MAX_SORT_RULES = 8
const MAX_FILTERS = 40
const MAX_FILTER_VALUES = 50
const KEY_MAX = 96
const FILTER_KEY_MAX = 64
const STRING_MAX = 200

/** Clamp an incoming width to the allowed range, or drop it if not a number. */
export function clampColumnWidth(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(n)))
}

/**
 * Normalize a column-preference list: drop malformed/duplicate keys, cap the
 * count, and carry through only the recognized per-column fields
 * (hidden/width/pinned). Order is preserved because position is significant.
 */
export function sanitizeColumns(raw: unknown): ColumnPref[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const out: ColumnPref[] = []
  for (const c of raw) {
    if (!c || typeof (c as any).key !== "string") continue
    const key = String((c as any).key).slice(0, KEY_MAX)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const pref: ColumnPref = { key, hidden: Boolean((c as any).hidden) }
    const width = clampColumnWidth((c as any).width)
    if (width != null) pref.width = width
    if ((c as any).pinned) pref.pinned = true
    out.push(pref)
    if (out.length >= MAX_COLUMNS) break
  }
  return out
}

function sanitizeSort(raw: unknown): SortRule[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw
    .filter((s) => s && typeof (s as any).key === "string")
    .slice(0, MAX_SORT_RULES)
    .map((s) => ({ key: String((s as any).key).slice(0, KEY_MAX), dir: (s as any).dir === "desc" ? "desc" : "asc" }) as SortRule)
}

function sanitizeFilters(raw: unknown): Record<string, string | string[] | null> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const filters: Record<string, string | string[] | null> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_FILTERS)) {
    const key = k.slice(0, FILTER_KEY_MAX)
    if (v == null) filters[key] = null
    else if (typeof v === "string") filters[key] = v.slice(0, STRING_MAX)
    else if (Array.isArray(v)) filters[key] = v.filter((x) => typeof x === "string").slice(0, MAX_FILTER_VALUES) as string[]
  }
  return filters
}

/**
 * Coerce arbitrary input (untrusted client JSON, or a raw/stringified DB value)
 * into a bounded, well-formed {@link TableViewConfig}. Never throws.
 */
export function sanitizeViewConfig(raw: unknown): TableViewConfig {
  let obj: any = raw
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw)
    } catch {
      obj = {}
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {}
  const pageSize = Number.isFinite(obj.pageSize) ? Math.min(500, Math.max(1, Math.trunc(obj.pageSize))) : undefined
  return {
    search: typeof obj.search === "string" ? obj.search.slice(0, STRING_MAX) : undefined,
    filters: sanitizeFilters(obj.filters),
    columns: sanitizeColumns(obj.columns),
    sort: sanitizeSort(obj.sort),
    groupBy: typeof obj.groupBy === "string" ? obj.groupBy.slice(0, KEY_MAX) : obj.groupBy === null ? null : undefined,
    pageSize,
  }
}
