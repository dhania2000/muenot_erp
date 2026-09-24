"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import {
  BarChart3,
  Calculator,
  CalendarRange,
  Columns3,
  Database,
  Download,
  Filter,
  Loader2,
  Plus,
  Save,
  Sigma,
  SortAsc,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { fetcher } from "@/lib/fetcher"
import type { PublicReportColumn, PublicReportSource } from "@/lib/reports/catalog"
import {
  aggregationsForType,
  columnAlias,
  operatorsForType,
  RANGE_OPERATORS,
  VALUELESS_OPERATORS,
  type Aggregation,
  type DateRangePreset,
  type FilterOperator,
  type ReportDefinition,
  type ReportFilter,
  type SelectedColumn,
} from "@/lib/reports/model"

const API = "/api/reports"

type CatalogMeta = {
  operators: { value: FilterOperator; label: string }[]
  aggregations: { value: Aggregation; label: string }[]
  dateRangePresets: { value: DateRangePreset; label: string }[]
  caps: {
    maxColumns: number
    maxFilters: number
    maxGroupBy: number
    maxSort: number
    maxRows: number
    previewRows: number
  }
}

type SavedReport = {
  id: number
  name: string
  description: string | null
  sourceKey: string
  definition: ReportDefinition
  createdByName: string | null
  updatedAt: string
}

type ListResponse = {
  reports: SavedReport[]
  catalog: PublicReportSource[]
  metadata: CatalogMeta
}

type RunResult = {
  columns: { key: string; label: string }[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  redactedFields: string[]
  aggregated: boolean
}

const emptyDefinition = (sourceKey: string): ReportDefinition => ({
  sourceKey,
  columns: [],
  filters: [],
  groupBy: [],
  sort: [],
  dateRange: null,
  limit: null,
})

export function ReportBuilder() {
  const { data, isLoading, mutate } = useSWR<ListResponse>(API, fetcher)

  const [activeReportId, setActiveReportId] = useState<number | null>(null)
  const [def, setDef] = useState<ReportDefinition | null>(null)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [result, setResult] = useState<RunResult | null>(null)
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState<string | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)

  const catalog = data?.catalog ?? []
  const meta = data?.metadata
  const source = useMemo(
    () => catalog.find((s) => s.key === def?.sourceKey) ?? null,
    [catalog, def?.sourceKey],
  )
  const columnsByKey = useMemo(() => {
    const m = new Map<string, PublicReportColumn>()
    for (const c of source?.columns ?? []) m.set(c.key, c)
    return m
  }, [source])

  const dateColumns = useMemo(
    () => (source?.columns ?? []).filter((c) => c.type === "date" || c.type === "datetime"),
    [source],
  )

  function startNew(sourceKey: string) {
    setActiveReportId(null)
    setDef(emptyDefinition(sourceKey))
    setName("")
    setDescription("")
    setResult(null)
  }

  function loadReport(r: SavedReport) {
    setActiveReportId(r.id)
    setDef(r.definition)
    setName(r.name)
    setDescription(r.description ?? "")
    setResult(null)
  }

  const patch = (partial: Partial<ReportDefinition>) => setDef((d) => (d ? { ...d, ...partial } : d))

  // --- column helpers ------------------------------------------------------
  function toggleColumn(key: string) {
    if (!def) return
    const exists = def.columns.some((c) => c.column === key && !c.aggregation)
    if (exists) {
      patch({
        columns: def.columns.filter((c) => !(c.column === key && !c.aggregation)),
        sort: def.sort.filter((s) => !(s.column === key && !s.aggregation)),
        groupBy: def.groupBy.filter((g) => g !== key),
      })
    } else {
      patch({ columns: [...def.columns, { column: key, aggregation: null }] })
    }
  }

  function addCalculation() {
    if (!def || !source) return
    const numeric = source.columns.find((c) => aggregationsForType(c.type).length > 0)
    if (!numeric) return
    const agg = aggregationsForType(numeric.type)[0]
    patch({ columns: [...def.columns, { column: numeric.key, aggregation: agg }] })
  }

  function updateCalc(index: number, partial: Partial<SelectedColumn>) {
    if (!def) return
    const next = def.columns.slice()
    next[index] = { ...next[index], ...partial }
    patch({ columns: next })
  }

  function removeColumn(index: number) {
    if (!def) return
    const removed = def.columns[index]
    patch({
      columns: def.columns.filter((_, i) => i !== index),
      sort: def.sort.filter((s) => !(s.column === removed.column && (s.aggregation ?? null) === (removed.aggregation ?? null))),
    })
  }

  // --- filters -------------------------------------------------------------
  function addFilter() {
    if (!def || !source) return
    const first = source.columns[0]
    if (!first) return
    const op = operatorsForType(first.type)[0]
    patch({ filters: [...def.filters, { column: first.key, operator: op, value: "", value2: "" }] })
  }

  function updateFilter(index: number, partial: Partial<ReportFilter>) {
    if (!def) return
    const next = def.filters.slice()
    let entry = { ...next[index], ...partial }
    // Reset the operator if the column type no longer permits it.
    if (partial.column) {
      const meta = columnsByKey.get(partial.column)
      if (meta && !operatorsForType(meta.type).includes(entry.operator)) {
        entry.operator = operatorsForType(meta.type)[0]
      }
    }
    next[index] = entry
    patch({ filters: next })
  }

  function removeFilter(index: number) {
    if (!def) return
    patch({ filters: def.filters.filter((_, i) => i !== index) })
  }

  // --- grouping / sorting --------------------------------------------------
  function toggleGroupBy(key: string) {
    if (!def) return
    const exists = def.groupBy.includes(key)
    patch({ groupBy: exists ? def.groupBy.filter((g) => g !== key) : [...def.groupBy, key] })
  }

  function addSort() {
    if (!def || def.columns.length === 0) return
    const first = def.columns[0]
    patch({ sort: [...def.sort, { column: first.column, aggregation: first.aggregation ?? null, direction: "asc" }] })
  }

  function updateSort(index: number, value: string) {
    if (!def) return
    const [column, aggRaw] = value.split("::")
    const aggregation = (aggRaw || null) as Aggregation | null
    const next = def.sort.slice()
    next[index] = { ...next[index], column, aggregation }
    patch({ sort: next })
  }

  function toggleSortDir(index: number) {
    if (!def) return
    const next = def.sort.slice()
    next[index] = { ...next[index], direction: next[index].direction === "asc" ? "desc" : "asc" }
    patch({ sort: next })
  }

  function removeSort(index: number) {
    if (!def) return
    patch({ sort: def.sort.filter((_, i) => i !== index) })
  }

  // --- date range ----------------------------------------------------------
  function setDateColumn(column: string) {
    if (!def) return
    if (!column) {
      patch({ dateRange: null })
      return
    }
    patch({ dateRange: { column, preset: def.dateRange?.preset ?? "last_30_days", from: def.dateRange?.from, to: def.dateRange?.to } })
  }

  // --- run / save / export -------------------------------------------------
  async function runPreview() {
    if (!def) return
    setRunning(true)
    setResult(null)
    try {
      const res = await fetch(`${API}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ definition: def }),
      })
      const json = await res.json()
      if (!res.ok) {
        const msg = json?.errors?.length ? json.errors.join(" ") : json?.error || "Could not run report."
        toast.error(msg)
        return
      }
      setResult(json as RunResult)
    } catch {
      toast.error("Could not run report.")
    } finally {
      setRunning(false)
    }
  }

  async function saveReport() {
    if (!def) return
    if (!name.trim()) {
      toast.error("A report name is required.")
      return
    }
    setSaving(true)
    try {
      const isUpdate = activeReportId != null
      const res = await fetch(isUpdate ? `${API}/${activeReportId}` : API, {
        method: isUpdate ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null, definition: def }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json?.error || "Could not save report.")
        return
      }
      toast.success(isUpdate ? "Report updated." : "Report saved.")
      setSaveOpen(false)
      if (!isUpdate && json?.report?.id) setActiveReportId(json.report.id)
      mutate()
    } catch {
      toast.error("Could not save report.")
    } finally {
      setSaving(false)
    }
  }

  async function deleteReport(id: number) {
    try {
      const res = await fetch(`${API}/${id}`, { method: "DELETE" })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        toast.error(json?.error || "Could not delete report.")
        return
      }
      toast.success("Report deleted.")
      if (activeReportId === id) {
        setActiveReportId(null)
        setDef(null)
      }
      mutate()
    } catch {
      toast.error("Could not delete report.")
    }
  }

  async function exportReport(format: "csv" | "xlsx" | "json") {
    if (!def) return
    setExporting(format)
    try {
      const res = await fetch(`${API}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ definition: def, name: name || "report", format }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        toast.error(json?.error || "Could not export report.")
        return
      }
      const blob = await res.blob()
      const disposition = res.headers.get("Content-Disposition") || ""
      const match = disposition.match(/filename="([^"]+)"/)
      const fileName = match?.[1] || `report.${format}`
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success("Export ready.")
    } catch {
      toast.error("Could not export report.")
    } finally {
      setExporting(null)
    }
  }

  if (isLoading) {
    return (
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Skeleton className="h-[420px] w-full" />
        <Skeleton className="h-[420px] w-full" />
      </div>
    )
  }

  const reports = data?.reports ?? []
  const selectedPlain = def?.columns.filter((c) => !c.aggregation) ?? []
  const hasAggregation = def?.columns.some((c) => c.aggregation) ?? false

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      {/* Sidebar: data sources + saved reports */}
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="size-4" /> Data source
            </CardTitle>
            <CardDescription>Pick what to report on.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {catalog.length === 0 && (
              <p className="text-sm text-muted-foreground">No data sources are available in this deployment.</p>
            )}
            {catalog.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => startNew(s.key)}
                className={`flex flex-col rounded-md border p-3 text-left transition-colors hover:bg-accent ${
                  def?.sourceKey === s.key && activeReportId === null ? "border-primary bg-accent" : "border-border"
                }`}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  {s.label}
                  <Badge variant="secondary" className="text-[10px]">
                    {s.module}
                  </Badge>
                </span>
                <span className="mt-0.5 text-xs text-muted-foreground">{s.description}</span>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Save className="size-4" /> Saved reports
            </CardTitle>
            <CardDescription>{reports.length} saved</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {reports.length === 0 && <p className="text-sm text-muted-foreground">No saved reports yet.</p>}
            {reports.map((r) => (
              <div
                key={r.id}
                className={`flex items-start justify-between gap-2 rounded-md border p-3 ${
                  activeReportId === r.id ? "border-primary bg-accent" : "border-border"
                }`}
              >
                <button type="button" onClick={() => loadReport(r)} className="flex flex-1 flex-col text-left">
                  <span className="text-sm font-medium">{r.name}</span>
                  <span className="mt-0.5 text-xs text-muted-foreground">
                    {catalog.find((s) => s.key === r.sourceKey)?.label ?? r.sourceKey}
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => deleteReport(r.id)}
                  aria-label={`Delete ${r.name}`}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Main builder */}
      {!def || !source ? (
        <Card className="flex min-h-[420px] items-center justify-center">
          <div className="flex max-w-sm flex-col items-center gap-2 text-center">
            <BarChart3 className="size-10 text-muted-foreground" />
            <p className="text-sm font-medium">Start a report</p>
            <p className="text-sm text-muted-foreground">
              Choose a data source on the left or open a saved report to begin building.
            </p>
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Columns */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Columns3 className="size-4" /> Columns
                <span className="text-xs font-normal text-muted-foreground">
                  ({selectedPlain.length}/{meta?.caps.maxColumns})
                </span>
              </CardTitle>
              <CardDescription>Select the fields to include.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {source.columns.map((c) => {
                const checked = def.columns.some((sc) => sc.column === c.key && !sc.aggregation)
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => toggleColumn(c.key)}
                    className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      checked ? "border-primary bg-primary/10" : "border-border hover:bg-accent"
                    }`}
                  >
                    <Checkbox checked={checked} className="pointer-events-none" />
                    {c.label}
                    <span className="text-[10px] uppercase text-muted-foreground">{c.type}</span>
                  </button>
                )
              })}
            </CardContent>
          </Card>

          {/* Calculations */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Calculator className="size-4" /> Calculations
              </CardTitle>
              <CardDescription>Aggregate values like sum, average or count. Requires grouping.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {def.columns.map((c, i) =>
                c.aggregation ? (
                  <div key={`${c.column}-${i}`} className="flex flex-wrap items-center gap-2">
                    <Select value={c.aggregation} onValueChange={(v) => updateCalc(i, { aggregation: v as Aggregation })}>
                      <SelectTrigger className="w-[150px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {aggregationsForType(columnsByKey.get(c.column)?.type ?? "number").map((a) => (
                          <SelectItem key={a} value={a}>
                            {meta?.aggregations.find((m) => m.value === a)?.label ?? a}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="text-sm text-muted-foreground">of</span>
                    <Select
                      value={c.column}
                      onValueChange={(v) => {
                        const t = columnsByKey.get(v)?.type ?? "number"
                        const allowed = aggregationsForType(t)
                        updateCalc(i, { column: v, aggregation: allowed.includes(c.aggregation!) ? c.aggregation : allowed[0] })
                      }}
                    >
                      <SelectTrigger className="w-[180px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {source.columns.map((sc) => (
                          <SelectItem key={sc.key} value={sc.key}>
                            {sc.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      onClick={() => removeColumn(i)}
                      aria-label="Remove calculation"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ) : null,
              )}
              <div>
                <Button variant="outline" size="sm" onClick={addCalculation} className="gap-1.5">
                  <Plus className="size-4" /> Add calculation
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Grouping */}
          {hasAggregation && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sigma className="size-4" /> Grouping
                  <span className="text-xs font-normal text-muted-foreground">
                    ({def.groupBy.length}/{meta?.caps.maxGroupBy})
                  </span>
                </CardTitle>
                <CardDescription>Group aggregated rows by these columns.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {source.columns.map((c) => {
                  const checked = def.groupBy.includes(c.key)
                  return (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => toggleGroupBy(c.key)}
                      className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                        checked ? "border-primary bg-primary/10" : "border-border hover:bg-accent"
                      }`}
                    >
                      <Checkbox checked={checked} className="pointer-events-none" />
                      {c.label}
                    </button>
                  )
                })}
              </CardContent>
            </Card>
          )}

          {/* Filters */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Filter className="size-4" /> Filters
                <span className="text-xs font-normal text-muted-foreground">
                  ({def.filters.length}/{meta?.caps.maxFilters})
                </span>
              </CardTitle>
              <CardDescription>Narrow the rows that match.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {def.filters.map((f, i) => {
                const colMeta = columnsByKey.get(f.column)
                const ops = colMeta ? operatorsForType(colMeta.type) : []
                const needsValue = !VALUELESS_OPERATORS.includes(f.operator)
                const needsSecond = RANGE_OPERATORS.includes(f.operator)
                const inputType = colMeta?.type === "number" ? "number" : colMeta?.type === "date" || colMeta?.type === "datetime" ? "date" : "text"
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Select value={f.column} onValueChange={(v) => updateFilter(i, { column: v })}>
                      <SelectTrigger className="w-[160px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {source.columns.map((c) => (
                          <SelectItem key={c.key} value={c.key}>
                            {c.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={f.operator} onValueChange={(v) => updateFilter(i, { operator: v as FilterOperator })}>
                      <SelectTrigger className="w-[170px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ops.map((o) => (
                          <SelectItem key={o} value={o}>
                            {meta?.operators.find((m) => m.value === o)?.label ?? o}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {needsValue && (
                      <Input
                        type={inputType}
                        value={f.value ?? ""}
                        placeholder={f.operator === "in" ? "a, b, c" : "value"}
                        onChange={(e) => updateFilter(i, { value: e.target.value })}
                        className="w-[150px]"
                      />
                    )}
                    {needsSecond && (
                      <Input
                        type={inputType}
                        value={f.value2 ?? ""}
                        placeholder="and"
                        onChange={(e) => updateFilter(i, { value2: e.target.value })}
                        className="w-[150px]"
                      />
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      onClick={() => removeFilter(i)}
                      aria-label="Remove filter"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                )
              })}
              <div>
                <Button variant="outline" size="sm" onClick={addFilter} className="gap-1.5">
                  <Plus className="size-4" /> Add filter
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Date range + Sorting */}
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarRange className="size-4" /> Date range
                </CardTitle>
                <CardDescription>Limit to a time window.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <Select value={def.dateRange?.column ?? "__none__"} onValueChange={(v) => setDateColumn(v === "__none__" ? "" : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="No date filter" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No date filter</SelectItem>
                    {dateColumns.map((c) => (
                      <SelectItem key={c.key} value={c.key}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {def.dateRange && (
                  <>
                    <Select
                      value={def.dateRange.preset}
                      onValueChange={(v) => patch({ dateRange: { ...def.dateRange!, preset: v as DateRangePreset } })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {meta?.dateRangePresets.map((p) => (
                          <SelectItem key={p.value} value={p.value}>
                            {p.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {def.dateRange.preset === "custom" && (
                      <div className="flex items-center gap-2">
                        <Input
                          type="date"
                          value={def.dateRange.from ?? ""}
                          onChange={(e) => patch({ dateRange: { ...def.dateRange!, from: e.target.value } })}
                        />
                        <span className="text-sm text-muted-foreground">to</span>
                        <Input
                          type="date"
                          value={def.dateRange.to ?? ""}
                          onChange={(e) => patch({ dateRange: { ...def.dateRange!, to: e.target.value } })}
                        />
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <SortAsc className="size-4" /> Sorting
                  <span className="text-xs font-normal text-muted-foreground">
                    ({def.sort.length}/{meta?.caps.maxSort})
                  </span>
                </CardTitle>
                <CardDescription>Order the results.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {def.sort.map((s, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Select value={`${s.column}::${s.aggregation ?? ""}`} onValueChange={(v) => updateSort(i, v)}>
                      <SelectTrigger className="flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {def.columns.map((c, ci) => {
                          const label = columnsByKey.get(c.column)?.label ?? c.column
                          return (
                            <SelectItem key={ci} value={`${c.column}::${c.aggregation ?? ""}`}>
                              {c.aggregation ? `${label} (${c.aggregation})` : label}
                            </SelectItem>
                          )
                        })}
                      </SelectContent>
                    </Select>
                    <Button variant="outline" size="sm" className="w-[76px]" onClick={() => toggleSortDir(i)}>
                      {s.direction === "asc" ? "Asc" : "Desc"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      onClick={() => removeSort(i)}
                      aria-label="Remove sort"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
                <div>
                  <Button variant="outline" size="sm" onClick={addSort} disabled={def.columns.length === 0} className="gap-1.5">
                    <Plus className="size-4" /> Add sort
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={runPreview} disabled={running || def.columns.length === 0} className="gap-1.5">
              {running ? <Loader2 className="size-4 animate-spin" /> : <BarChart3 className="size-4" />}
              Run preview
            </Button>
            <Button variant="outline" onClick={() => setSaveOpen(true)} disabled={def.columns.length === 0} className="gap-1.5">
              <Save className="size-4" /> {activeReportId ? "Update" : "Save"}
            </Button>
            <div className="mx-1 h-6 w-px bg-border" />
            {(["csv", "xlsx", "json"] as const).map((fmt) => (
              <Button
                key={fmt}
                variant="outline"
                size="sm"
                onClick={() => exportReport(fmt)}
                disabled={!!exporting || def.columns.length === 0}
                className="gap-1.5 uppercase"
              >
                {exporting === fmt ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                {fmt}
              </Button>
            ))}
          </div>

          {/* Results */}
          {result && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  Results
                  <Badge variant="secondary">{result.rowCount} rows</Badge>
                  {result.truncated && (
                    <Badge variant="outline" className="gap-1 text-amber-600">
                      <TriangleAlert className="size-3" /> capped at {meta?.caps.maxRows.toLocaleString()}
                    </Badge>
                  )}
                  {result.redactedFields.length > 0 && (
                    <Badge variant="outline" className="gap-1 text-muted-foreground">
                      {result.redactedFields.length} field(s) redacted
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {result.rows.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">No rows matched this report.</p>
                ) : (
                  <div className="max-h-[480px] overflow-auto rounded-md border">
                    <Table>
                      <TableHeader className="sticky top-0 bg-muted">
                        <TableRow>
                          {result.columns.map((c) => (
                            <TableHead key={c.key} className="whitespace-nowrap">
                              {c.label}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.rows.map((row, ri) => (
                          <TableRow key={ri}>
                            {result.columns.map((c) => (
                              <TableCell key={c.key} className="whitespace-nowrap">
                                {formatCell(row[c.key])}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Save dialog */}
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{activeReportId ? "Update report" : "Save report"}</DialogTitle>
            <DialogDescription>Give this report a name so you can re-run it later.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="report-name">Name</Label>
              <Input id="report-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Monthly revenue by client" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="report-desc">Description</Label>
              <Textarea
                id="report-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional notes about this report."
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveReport} disabled={saving} className="gap-1.5">
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {activeReportId ? "Update" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}
