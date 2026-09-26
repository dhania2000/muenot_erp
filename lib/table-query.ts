/**
 * Server pagination / sort / search parser shared by list endpoints.
 *
 * Every value that ends up in SQL is either a bound parameter or looked up in a
 * caller-supplied whitelist, so a request can never inject a column name or a
 * direction. Pure (no DB access) so it is unit-tested directly.
 */

export const TABLE_PAGE_SIZES = [10, 25, 50, 100] as const
export const MAX_PAGE_SIZE = 100
export const MAX_SEARCH_LENGTH = 120

export type SortSpec = { key: string; dir: "asc" | "desc" }

export type TableQuery = {
  page: number
  pageSize: number
  offset: number
  search: string
  sort: SortSpec | null
  filters: Record<string, string>
}

export type TableQueryOptions = {
  /** Public sort key → trusted SQL expression. */
  sortable: Record<string, string>
  /** Allowed filter keys → allowed values (exact match). */
  filters?: Record<string, readonly string[]>
  defaultPageSize?: number
}

export class TableQueryError extends Error {
  status = 400
}

function toInt(raw: string | null, fallback: number): number {
  if (raw == null || raw === "") return fallback
  const n = Number(raw)
  if (!Number.isInteger(n)) throw new TableQueryError(`Expected an integer, got "${raw.slice(0, 20)}"`)
  return n
}

export function parseTableQuery(params: URLSearchParams, opts: TableQueryOptions): TableQuery {
  const page = toInt(params.get("page"), 1)
  if (page < 1 || page > 100_000) throw new TableQueryError("page must be between 1 and 100000")

  const pageSize = toInt(params.get("pageSize"), opts.defaultPageSize ?? 25)
  if (pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new TableQueryError(`pageSize must be between 1 and ${MAX_PAGE_SIZE}`)
  }

  const search = (params.get("q") ?? "").trim().slice(0, MAX_SEARCH_LENGTH)

  let sort: SortSpec | null = null
  const sortKey = params.get("sort")
  if (sortKey) {
    if (!Object.prototype.hasOwnProperty.call(opts.sortable, sortKey)) {
      throw new TableQueryError(`Unsupported sort column "${sortKey.slice(0, 40)}"`)
    }
    const dir = params.get("dir") === "desc" ? "desc" : "asc"
    sort = { key: sortKey, dir }
  }

  const filters: Record<string, string> = {}
  for (const [key, allowed] of Object.entries(opts.filters ?? {})) {
    const value = params.get(key)
    if (value == null || value === "") continue
    if (!allowed.includes(value)) throw new TableQueryError(`Invalid value for filter "${key}"`)
    filters[key] = value
  }

  return { page, pageSize, offset: (page - 1) * pageSize, search, sort, filters }
}

/** ORDER BY clause built only from whitelisted expressions, with a stable tiebreak. */
export function orderByClause(q: TableQuery, opts: TableQueryOptions, fallback: string, tiebreak: string): string {
  if (!q.sort) return `ORDER BY ${fallback}, ${tiebreak}`
  const expr = opts.sortable[q.sort.key]
  return `ORDER BY ${expr} ${q.sort.dir === "desc" ? "DESC" : "ASC"}, ${tiebreak}`
}

/** Escape LIKE wildcards so user search text matches literally. */
export function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

export type PagedResponse<T> = {
  rows: T[]
  total: number
  page: number
  pageSize: number
  pageCount: number
}

export function pageMeta(q: TableQuery, total: number) {
  return { total, page: q.page, pageSize: q.pageSize, pageCount: Math.max(1, Math.ceil(total / q.pageSize)) }
}
