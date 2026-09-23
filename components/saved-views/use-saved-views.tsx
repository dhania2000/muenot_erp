"use client"

/**
 * SPEC 84 — Saved Views: reusable client hook.
 *
 * `useSavedViews` gives any table a complete, persistable presentation state
 * (search, filters, column order/visibility, sorting, grouping, page size) plus
 * the CRUD wiring for personal/public/role/team saved views. Tables own how they
 * render and how they apply the state to their rows; this hook owns the state
 * shape, dirty-tracking and persistence so every table behaves consistently.
 */

import { useCallback, useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import type {
  ColumnPref,
  SavedViewRecord,
  SavedViewsBootstrap,
  SortRule,
  TableViewConfig,
  ViewColumnDef,
  ViewVisibility,
} from "@/lib/saved-views/types"

export type ViewState = {
  search: string
  filters: Record<string, string | string[] | null>
  columns: ColumnPref[]
  sort: SortRule[]
  groupBy: string | null
  pageSize: number
}

export type SaveViewArgs = {
  name: string
  visibility: ViewVisibility
  roleKey?: string | null
  teamKey?: string | null
  isDefault?: boolean
}

function defaultColumns(defs: ViewColumnDef[]): ColumnPref[] {
  return defs.map((d) => ({ key: d.key, hidden: Boolean(d.defaultHidden) }))
}

function buildInitialState(defs: ViewColumnDef[], seed?: Partial<ViewState>): ViewState {
  return {
    search: seed?.search ?? "",
    filters: seed?.filters ?? {},
    columns: seed?.columns ?? defaultColumns(defs),
    sort: seed?.sort ?? [],
    groupBy: seed?.groupBy ?? null,
    pageSize: seed?.pageSize ?? 25,
  }
}

/**
 * Merge a stored view config against the current column set so a view saved
 * before a column was added/removed still resolves cleanly: known columns keep
 * the saved order/visibility, unknown ones are dropped, and newly added columns
 * are appended in their default state.
 */
function stateFromConfig(defs: ViewColumnDef[], config: TableViewConfig, fallback: ViewState): ViewState {
  const known = new Map(defs.map((d) => [d.key, d]))
  let columns: ColumnPref[]
  if (Array.isArray(config.columns) && config.columns.length) {
    const seen = new Set<string>()
    columns = config.columns
      .filter((c) => known.has(c.key) && !seen.has(c.key) && (seen.add(c.key), true))
      .map((c) => ({ key: c.key, hidden: Boolean(c.hidden) }))
    for (const d of defs) if (!seen.has(d.key)) columns.push({ key: d.key, hidden: Boolean(d.defaultHidden) })
  } else {
    columns = defaultColumns(defs)
  }
  const sort = Array.isArray(config.sort) ? config.sort.filter((s) => known.has(s.key)) : []
  return {
    search: config.search ?? "",
    filters: config.filters ?? {},
    columns,
    sort,
    groupBy: config.groupBy != null && known.has(config.groupBy) ? config.groupBy : null,
    pageSize: config.pageSize ?? fallback.pageSize,
  }
}

function configFromState(state: ViewState): TableViewConfig {
  return {
    search: state.search || undefined,
    filters: Object.keys(state.filters).length ? state.filters : undefined,
    columns: state.columns,
    sort: state.sort.length ? state.sort : undefined,
    groupBy: state.groupBy,
    pageSize: state.pageSize,
  }
}

export type UseSavedViewsOptions = {
  tableKey: string
  columns: ViewColumnDef[]
  initial?: Partial<ViewState>
}

export function useSavedViews({ tableKey, columns, initial }: UseSavedViewsOptions) {
  const baseState = useMemo(() => buildInitialState(columns, initial), [columns, initial])
  const [state, setState] = useState<ViewState>(baseState)
  const [activeViewId, setActiveViewId] = useState<number | null>(null)

  const { data, isLoading, mutate } = useSWR<SavedViewsBootstrap>(
    `/api/saved-views?table=${encodeURIComponent(tableKey)}`,
    fetcher,
    { revalidateOnFocus: false },
  )

  const views = data?.views ?? []
  const activeView = useMemo(() => views.find((v) => v.id === activeViewId) ?? null, [views, activeViewId])

  const currentComparable = useMemo(() => JSON.stringify(stateToComparable(state)), [state])
  const activeComparable = useMemo(
    () =>
      JSON.stringify(
        stateToComparable(activeView ? stateFromConfig(columns, activeView.config, baseState) : baseState),
      ),
    [activeView, columns, baseState],
  )
  const isDirty = currentComparable !== activeComparable

  // --- state mutators ------------------------------------------------------
  const setSearch = useCallback((search: string) => setState((s) => ({ ...s, search })), [])
  const setPageSize = useCallback((pageSize: number) => setState((s) => ({ ...s, pageSize })), [])
  const setGroupBy = useCallback((groupBy: string | null) => setState((s) => ({ ...s, groupBy })), [])
  const setFilter = useCallback(
    (key: string, value: string | string[] | null) =>
      setState((s) => {
        const filters = { ...s.filters }
        if (value == null || (Array.isArray(value) && value.length === 0) || value === "") delete filters[key]
        else filters[key] = value
        return { ...s, filters }
      }),
    [],
  )
  const toggleColumn = useCallback(
    (key: string) =>
      setState((s) => ({
        ...s,
        columns: s.columns.map((c) => (c.key === key ? { ...c, hidden: !c.hidden } : c)),
      })),
    [],
  )
  const moveColumn = useCallback(
    (key: string, dir: -1 | 1) =>
      setState((s) => {
        const idx = s.columns.findIndex((c) => c.key === key)
        const next = idx + dir
        if (idx < 0 || next < 0 || next >= s.columns.length) return s
        const cols = s.columns.slice()
        ;[cols[idx], cols[next]] = [cols[next], cols[idx]]
        return { ...s, columns: cols }
      }),
    [],
  )
  const toggleSort = useCallback(
    (key: string) =>
      setState((s) => {
        const existing = s.sort.find((r) => r.key === key)
        if (!existing) return { ...s, sort: [{ key, dir: "asc" }] }
        if (existing.dir === "asc") return { ...s, sort: [{ key, dir: "desc" }] }
        return { ...s, sort: [] }
      }),
    [],
  )

  const applyView = useCallback(
    (id: number | null) => {
      if (id == null) {
        setActiveViewId(null)
        setState(baseState)
        return
      }
      const view = views.find((v) => v.id === id)
      if (!view) return
      setActiveViewId(id)
      setState(stateFromConfig(columns, view.config, baseState))
    },
    [views, columns, baseState],
  )

  const resetToDefault = useCallback(() => {
    if (activeView) setState(stateFromConfig(columns, activeView.config, baseState))
    else setState(baseState)
  }, [activeView, columns, baseState])

  // --- persistence ---------------------------------------------------------
  const [busy, setBusy] = useState(false)

  const saveAs = useCallback(
    async (args: SaveViewArgs) => {
      setBusy(true)
      try {
        const res = await fetch("/api/saved-views", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tableKey,
            name: args.name,
            visibility: args.visibility,
            roleKey: args.roleKey ?? null,
            teamKey: args.teamKey ?? null,
            isDefault: args.isDefault ?? false,
            config: configFromState(state),
          }),
        })
        const body = await res.json().catch(() => ({}) as any)
        if (!res.ok) {
          toast.error(body.error || "Unable to save view")
          return false
        }
        await mutate()
        if (body.id) setActiveViewId(Number(body.id))
        toast.success(`Saved view "${args.name}"`)
        return true
      } finally {
        setBusy(false)
      }
    },
    [tableKey, state, mutate],
  )

  const updateActive = useCallback(async () => {
    if (!activeView) return false
    setBusy(true)
    try {
      const res = await fetch(`/api/saved-views/${activeView.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tableKey,
          name: activeView.name,
          visibility: activeView.visibility,
          roleKey: activeView.roleKey,
          teamKey: activeView.teamKey,
          isDefault: activeView.isDefault,
          config: configFromState(state),
        }),
      })
      const body = await res.json().catch(() => ({}) as any)
      if (!res.ok) {
        toast.error(body.error || "Unable to update view")
        return false
      }
      await mutate()
      toast.success(`Updated "${activeView.name}"`)
      return true
    } finally {
      setBusy(false)
    }
  }, [activeView, tableKey, state, mutate])

  const remove = useCallback(
    async (id: number) => {
      setBusy(true)
      try {
        const res = await fetch(`/api/saved-views/${id}`, { method: "DELETE" })
        const body = await res.json().catch(() => ({}) as any)
        if (!res.ok) {
          toast.error(body.error || "Unable to delete view")
          return false
        }
        if (activeViewId === id) applyView(null)
        await mutate()
        toast.success("View deleted")
        return true
      } finally {
        setBusy(false)
      }
    },
    [activeViewId, applyView, mutate],
  )

  return {
    // data
    columns,
    views,
    activeView,
    activeViewId,
    isLoading,
    isDirty,
    busy,
    permissions: data?.permissions ?? { canManageShared: false },
    roles: data?.roles ?? [],
    teams: data?.teams ?? [],
    // state
    state,
    // mutators
    setSearch,
    setPageSize,
    setGroupBy,
    setFilter,
    toggleColumn,
    moveColumn,
    toggleSort,
    // views
    applyView,
    resetToDefault,
    saveAs,
    updateActive,
    remove,
  }
}

/** Fields that make a view "dirty" — order and search/sort/filters/paging. */
function stateToComparable(state: ViewState) {
  return {
    search: state.search || "",
    filters: state.filters,
    columns: state.columns.map((c) => ({ key: c.key, hidden: Boolean(c.hidden) })),
    sort: state.sort,
    groupBy: state.groupBy ?? null,
    pageSize: state.pageSize,
  }
}

/**
 * Sort helper tables can reuse: applies the view's multi-key sort using a
 * per-column value accessor. Values are compared numerically when both look
 * numeric, otherwise as case-insensitive strings.
 */
export function sortRows<T>(rows: T[], sort: SortRule[], accessor: (row: T, key: string) => unknown): T[] {
  if (!sort.length) return rows
  const copy = rows.slice()
  copy.sort((a, b) => {
    for (const rule of sort) {
      const av = accessor(a, rule.key)
      const bv = accessor(b, rule.key)
      const cmp = compareValues(av, bv)
      if (cmp !== 0) return rule.dir === "asc" ? cmp : -cmp
    }
    return 0
  })
  return copy
}

function compareValues(a: unknown, b: unknown): number {
  const an = a == null || a === "" ? null : Number(a)
  const bn = b == null || b === "" ? null : Number(b)
  if (an != null && bn != null && !Number.isNaN(an) && !Number.isNaN(bn)) return an - bn
  const as = a == null ? "" : String(a).toLowerCase()
  const bs = b == null ? "" : String(b).toLowerCase()
  if (as < bs) return -1
  if (as > bs) return 1
  return 0
}
