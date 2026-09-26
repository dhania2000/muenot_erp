"use client"

/**
 * Accessible, saved-view-driven data table.
 *
 * Renders the column order/visibility/width/pin/sort/group state owned by
 * `useSavedViews`, so every table that adopts it persists the same
 * preferences through the existing saved-views API. Rows are supplied one
 * server page at a time; grouping groups the rows of the current page.
 */

import { Fragment, useId, useRef } from "react"
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, ErrorState } from "@/components/enterprise/data-state"
import { cn } from "@/lib/utils"
import { DEFAULT_COLUMN_WIDTH, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from "@/lib/saved-views/types"
import type { ColumnPref } from "@/lib/saved-views/types"
import type { useSavedViews } from "./use-saved-views"

type Hook = ReturnType<typeof useSavedViews>

const RESIZE_STEP = 16
const ACTIONS_WIDTH = 64

export type DataTableProps<T> = {
  hook: Hook
  caption: string
  rows: T[]
  getRowId: (row: T) => string | number
  renderCell: (key: string, row: T) => React.ReactNode
  cellClassName?: Record<string, string>
  groupValue?: (row: T, key: string) => string
  rowActions?: (row: T) => React.ReactNode
  isLoading?: boolean
  isValidating?: boolean
  error?: unknown
  onRetry?: () => void
  total: number
  page: number
  pageCount: number
  onPageChange: (page: number) => void
  emptyTitle?: string
  emptyDescription?: string
}

/** Visible columns with pinned ones first, plus the sticky left offset of each pinned column. */
export function layoutColumns(columns: ColumnPref[]) {
  const visible = columns.filter((c) => !c.hidden)
  const ordered = [...visible.filter((c) => c.pinned), ...visible.filter((c) => !c.pinned)]
  let offset = 0
  return ordered.map((c) => {
    const width = c.width ?? (c.pinned ? DEFAULT_COLUMN_WIDTH : undefined)
    const left = c.pinned ? offset : undefined
    if (c.pinned) offset += width ?? DEFAULT_COLUMN_WIDTH
    return { ...c, width, left }
  })
}

export function DataTable<T>(props: DataTableProps<T>) {
  const {
    hook,
    caption,
    rows,
    getRowId,
    renderCell,
    cellClassName = {},
    groupValue,
    rowActions,
    isLoading,
    isValidating,
    error,
    onRetry,
    total,
    page,
    pageCount,
    onPageChange,
    emptyTitle = "No records found",
    emptyDescription,
  } = props
  const captionId = useId()
  const { state, columns: defs, toggleSort, setColumnWidth } = hook
  const defByKey = new Map(defs.map((d) => [d.key, d]))
  const cols = layoutColumns(state.columns)
  const colSpan = cols.length + (rowActions ? 1 : 0)

  const groups: { label: string; rows: T[] }[] = []
  if (state.groupBy && groupValue) {
    const index = new Map<string, T[]>()
    for (const row of rows) {
      const label = groupValue(row, state.groupBy) || "—"
      if (!index.has(label)) {
        index.set(label, [])
        groups.push({ label, rows: index.get(label)! })
      }
      index.get(label)!.push(row)
    }
  } else {
    groups.push({ label: "", rows })
  }

  const from = total === 0 ? 0 : (page - 1) * state.pageSize + 1
  const to = Math.min(total, page * state.pageSize)
  const status = isLoading
    ? "Loading records"
    : error
      ? "Records failed to load"
      : `Showing ${from} to ${to} of ${total} records, page ${page} of ${pageCount}`

  function renderRow(row: T) {
    return (
      <tr key={getRowId(row)} className="border-b border-border transition-colors hover:bg-muted/50">
        {cols.map((c, i) => {
          const Cell = i === 0 ? "th" : "td"
          return (
            <Cell
              key={c.key}
              scope={i === 0 ? "row" : undefined}
              style={{ width: c.width, maxWidth: c.width, left: c.left }}
              className={cn(
                "px-3 py-2 text-left align-middle text-sm font-normal",
                c.width != null && "truncate",
                c.pinned && "sticky z-10 bg-card",
                cellClassName[c.key],
              )}
            >
              {renderCell(c.key, row)}
            </Cell>
          )
        })}
        {rowActions && (
          <td className="px-3 py-2 text-right" style={{ width: ACTIONS_WIDTH }}>
            {rowActions(row)}
          </td>
        )}
      </tr>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      <div
        role="region"
        aria-labelledby={captionId}
        tabIndex={0}
        className="overflow-x-auto rounded-md border border-border bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <table className="w-full border-collapse text-sm" aria-busy={isLoading || isValidating || undefined}>
          <caption id={captionId} className="sr-only">
            {caption}. Column headers with sort buttons can be activated to sort. Use the resize handles with the left
            and right arrow keys to change column width.
          </caption>
          <thead className="border-b border-border">
            <tr>
              {cols.map((c) => {
                const def = defByKey.get(c.key)
                const label = def?.label ?? c.key
                const rule = state.sort.find((s) => s.key === c.key)
                const ariaSort = rule ? (rule.dir === "asc" ? "ascending" : "descending") : def?.sortable ? "none" : undefined
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={ariaSort}
                    style={{ width: c.width, minWidth: c.width, left: c.left }}
                    className={cn(
                      "group relative h-10 whitespace-nowrap px-3 text-left align-middle text-xs font-medium text-muted-foreground",
                      c.pinned && "sticky z-20 bg-card",
                    )}
                  >
                    {def?.sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        className="-mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {label}
                        {rule?.dir === "asc" ? (
                          <ArrowUp className="size-3.5" aria-hidden="true" />
                        ) : rule?.dir === "desc" ? (
                          <ArrowDown className="size-3.5" aria-hidden="true" />
                        ) : (
                          <ChevronsUpDown className="size-3.5 opacity-50" aria-hidden="true" />
                        )}
                        <span className="sr-only">
                          {rule ? `, sorted ${rule.dir === "asc" ? "ascending" : "descending"}` : ", not sorted"}
                        </span>
                      </button>
                    ) : (
                      label
                    )}
                    {c.pinned && <span className="sr-only">, pinned</span>}
                    <ResizeHandle
                      label={label}
                      width={c.width}
                      onResize={(w) => setColumnWidth(c.key, w)}
                    />
                  </th>
                )
              })}
              {rowActions && (
                <th scope="col" className="h-10 px-3 text-right text-xs font-medium text-muted-foreground" style={{ width: ACTIONS_WIDTH }}>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {isLoading &&
              Array.from({ length: Math.min(state.pageSize, 8) }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-b border-border" aria-hidden="true">
                  {Array.from({ length: colSpan }).map((__, j) => (
                    <td key={j} className="px-3 py-3">
                      <Skeleton className="h-4 w-full max-w-40" />
                    </td>
                  ))}
                </tr>
              ))}
            {!isLoading && Boolean(error) && (
              <tr>
                <td colSpan={colSpan}>
                  <ErrorState
                    title="Could not load records"
                    message={error instanceof Error ? error.message : undefined}
                    onRetry={onRetry}
                  />
                </td>
              </tr>
            )}
            {!isLoading && !error && rows.length === 0 && (
              <tr>
                <td colSpan={colSpan}>
                  <EmptyState title={emptyTitle} description={emptyDescription} />
                </td>
              </tr>
            )}
            {!isLoading &&
              !error &&
              groups.map((g) => (
                <Fragment key={g.label || "all"}>
                  {state.groupBy && (
                    <tr className="bg-muted/60">
                      <th scope="rowgroup" colSpan={colSpan} className="px-3 py-1.5 text-left text-xs font-semibold">
                        {defByKey.get(state.groupBy)?.label}: {g.label}{" "}
                        <span className="font-normal text-muted-foreground">({g.rows.length})</span>
                      </th>
                    </tr>
                  )}
                  {g.rows.map(renderRow)}
                </Fragment>
              ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} pageCount={pageCount} from={from} to={to} total={total} onPageChange={onPageChange} />
    </div>
  )
}

/**
 * Column resize handle. Pointer drag for mouse/touch; a focusable separator
 * with Left/Right arrows (Home resets) for keyboard and screen-reader users.
 */
function ResizeHandle({
  label,
  width,
  onResize,
}: {
  label: string
  width?: number
  onResize: (width: number | null) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  function currentWidth() {
    return width ?? ref.current?.parentElement?.getBoundingClientRect().width ?? DEFAULT_COLUMN_WIDTH
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const startX = e.clientX
    const start = currentWidth()
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => onResize(start + ev.clientX - startX)
    const up = () => {
      target.removeEventListener("pointermove", move)
      target.removeEventListener("pointerup", up)
    }
    target.addEventListener("pointermove", move)
    target.addEventListener("pointerup", up)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault()
      onResize(currentWidth() + (e.key === "ArrowRight" ? RESIZE_STEP : -RESIZE_STEP))
    } else if (e.key === "Home") {
      e.preventDefault()
      onResize(null)
    }
  }

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      aria-valuemin={MIN_COLUMN_WIDTH}
      aria-valuemax={MAX_COLUMN_WIDTH}
      aria-valuenow={width != null ? Math.round(width) : undefined}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(null)}
      className="absolute inset-y-1 right-0 w-2 cursor-col-resize touch-none rounded-sm after:absolute after:inset-y-1 after:left-1/2 after:w-px after:bg-border hover:after:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  )
}

function Pager({
  page,
  pageCount,
  from,
  to,
  total,
  onPageChange,
}: {
  page: number
  pageCount: number
  from: number
  to: number
  total: number
  onPageChange: (page: number) => void
}) {
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <p className="text-muted-foreground">
        {total === 0 ? "No records" : `${from}–${to} of ${total.toLocaleString()}`}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft className="size-4" aria-hidden="true" />
          <span>Previous</span>
        </Button>
        <span className="tabular-nums text-muted-foreground">
          Page {page} of {pageCount}
        </span>
        <Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>
          <span>Next</span>
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </nav>
  )
}
