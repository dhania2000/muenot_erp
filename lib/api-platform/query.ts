import "server-only"
/**
 * SPEC 51 — Pagination, filtering, and sorting standards.
 * ---------------------------------------------------------------------------
 * A single, consistent query-parameter contract for every collection endpoint:
 *
 *   Pagination:  ?page=1&per_page=50           (page is 1-based)
 *   Sorting:     ?sort=created_at   (asc)  |  ?sort=-created_at  (desc)
 *   Filtering:   ?filter[status]=active&filter[client_type]=Company
 *
 * Callers pass allowlists of sortable / filterable columns; anything outside
 * the allowlist throws a `validation_failed` ApiError rather than being
 * silently ignored, so integrations fail loudly on typos instead of getting
 * unexpected data. The parsed result yields safe SQL fragments (identifiers
 * are validated against the allowlist, values are always parameterized).
 */
import { ApiError, validationError } from "@/lib/api-platform/errors"
import { query } from "@/lib/db"

export const DEFAULT_PER_PAGE = 50
export const MAX_PER_PAGE = 200

export type ParsedPagination = {
  page: number
  perPage: number
  limit: number
  offset: number
}

export function parsePagination(url: URL): ParsedPagination {
  const rawPage = url.searchParams.get("page")
  const rawPerPage = url.searchParams.get("per_page")

  const page = Math.max(1, Number.isFinite(Number(rawPage)) ? Math.trunc(Number(rawPage || 1)) : 1)
  let perPage = Number.isFinite(Number(rawPerPage)) ? Math.trunc(Number(rawPerPage || DEFAULT_PER_PAGE)) : DEFAULT_PER_PAGE
  if (perPage < 1) perPage = DEFAULT_PER_PAGE
  if (perPage > MAX_PER_PAGE) perPage = MAX_PER_PAGE

  return { page, perPage, limit: perPage, offset: (page - 1) * perPage }
}

export type ParsedSort = {
  /** The single sort column, or null when no sort was requested. */
  column: string | null
  direction: "ASC" | "DESC"
  /** The normalized `sort` string echoed back in meta (e.g. "-created_at"). */
  raw: string | null
}

/**
 * Parses `?sort=col` / `?sort=-col`. `sortable` is the set of column names an
 * endpoint permits. Unknown columns are rejected.
 */
export function parseSort(url: URL, sortable: readonly string[], fallback?: string): ParsedSort {
  const raw = url.searchParams.get("sort")
  if (!raw) {
    if (!fallback) return { column: null, direction: "ASC", raw: null }
    const desc = fallback.startsWith("-")
    return { column: desc ? fallback.slice(1) : fallback, direction: desc ? "DESC" : "ASC", raw: fallback }
  }
  const desc = raw.startsWith("-")
  const column = desc ? raw.slice(1) : raw
  if (!sortable.includes(column)) {
    throw validationError({ sort: `Cannot sort by "${column}". Allowed: ${sortable.join(", ")}` })
  }
  return { column, direction: desc ? "DESC" : "ASC", raw }
}

export type ParsedFilters = Record<string, string>

/**
 * Parses `?filter[field]=value` pairs, restricted to `filterable`. Returns a
 * plain map of column → value; the caller builds a parameterized WHERE clause
 * with `buildWhere`.
 */
export function parseFilters(url: URL, filterable: readonly string[]): ParsedFilters {
  const out: ParsedFilters = {}
  for (const [key, value] of url.searchParams.entries()) {
    const match = /^filter\[(.+)\]$/.exec(key)
    if (!match) continue
    const field = match[1]
    if (!filterable.includes(field)) {
      throw validationError({ [`filter[${field}]`]: `Unknown filter. Allowed: ${filterable.join(", ")}` })
    }
    out[field] = value
  }
  return out
}

/**
 * Turns a parsed filter map into a SQL fragment + params. Every identifier is
 * one already validated against the endpoint's allowlist, and every value is
 * parameterized — so this is injection-safe by construction.
 */
export function buildWhere(filters: ParsedFilters): { clause: string; params: unknown[] } {
  const keys = Object.keys(filters)
  if (keys.length === 0) return { clause: "", params: [] }
  const clause = keys.map((k) => `\`${k}\` = ?`).join(" AND ")
  const params = keys.map((k) => filters[k])
  return { clause, params }
}

export function buildOrderBy(sort: ParsedSort): string {
  if (!sort.column) return ""
  return `ORDER BY \`${sort.column}\` ${sort.direction}`
}

export type PaginatedResult<T> = {
  rows: T[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

/**
 * SPEC 79 — Database performance: run the `COUNT(*)` and the page `SELECT` for
 * a list endpoint concurrently instead of one after the other, halving the
 * round-trip latency of the common "rows + total" response.
 *
 * Callers pass the shared FROM/WHERE (`fromWhere`, e.g.
 * "FROM `sales_leads` WHERE tenant_id = ? AND status = ?") with its params, the
 * column list, and the already-parsed ORDER BY + pagination. The page params
 * are the shared params plus LIMIT/OFFSET; the count reuses the shared params
 * only. Both statements go through `query`, so the tenant guard still applies.
 */
export async function paginatedList<T = any>(opts: {
  columns?: string
  fromWhere: string
  params?: any[]
  orderBy?: string
  pagination: ParsedPagination
}): Promise<PaginatedResult<T>> {
  const { fromWhere, pagination } = opts
  const params = opts.params ?? []
  const columns = opts.columns ?? "*"
  const orderBy = opts.orderBy ? ` ${opts.orderBy}` : ""

  const [rows, countRows] = await Promise.all([
    query<T[]>(
      `SELECT ${columns} ${fromWhere}${orderBy} LIMIT ? OFFSET ?`,
      [...params, pagination.limit, pagination.offset],
    ),
    query<Array<{ total: number }>>(`SELECT COUNT(*) AS total ${fromWhere}`, params),
  ])

  const total = Number(countRows[0]?.total ?? 0)
  return {
    rows,
    total,
    page: pagination.page,
    perPage: pagination.perPage,
    totalPages: Math.max(1, Math.ceil(total / pagination.perPage)),
  }
}

/** Combines parsed pieces into everything a list query needs. Convenience only. */
export function parseListQuery(
  url: URL,
  opts: { sortable: readonly string[]; filterable: readonly string[]; defaultSort?: string },
): { pagination: ParsedPagination; sort: ParsedSort; filters: ParsedFilters } {
  try {
    return {
      pagination: parsePagination(url),
      sort: parseSort(url, opts.sortable, opts.defaultSort),
      filters: parseFilters(url, opts.filterable),
    }
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError("bad_request", "Invalid query parameters")
  }
}
