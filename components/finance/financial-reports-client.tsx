"use client"

import useSWR from "swr"
import { useEffect, useMemo, useState } from "react"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import {
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  FileBarChart,
  FileSpreadsheet,
  FileText,
  FilterX,
  Mail,
  RefreshCw,
} from "lucide-react"
import { inr0 } from "@/lib/finance-calc"
import { exportReportCsv, exportReportExcel } from "@/lib/report-excel"
import { exportReportPdf } from "@/lib/report-pdf"
import type { ReportExportPayload } from "@/lib/report-tally"
import type { PeriodMode } from "@/lib/finance-reports"
import { ReportViewDialog, type ReportCompany } from "@/components/finance/report-view-dialog"
import { ReportEmailDialog } from "@/components/finance/report-email-dialog"
import { ReportHistoryPanel } from "@/components/finance/report-history-panel"
import { ReportDrillDrawer, type DrillTarget } from "@/components/finance/report-drill-drawer"
import {
  defaultPeriod,
  fyOptions,
  monthOptions,
  periodLabel,
  QUARTER_OPTIONS,
  resolveRange,
  type PeriodPreset,
  type PeriodState,
} from "@/lib/report-period"

type ReportColumn = {
  key: string
  label: string
  align?: "left" | "right"
  money?: boolean
}

type FilterMeta = { dim: string; label: string }

// Actions that a per-report row button can trigger. They are queued as a
// "pending action" on the parent, then executed by ReportView once that
// report's data has loaded.
type RowAction = "view" | "csv" | "excel" | "pdf" | "email"

type CatalogueEntry = {
  key: string
  label: string
  group: string
  description: string
  periodMode: PeriodMode
  filters: FilterMeta[]
}

type ReportResponse = {
  report: {
    key: string
    label: string
    group: string
    description: string
    columns: ReportColumn[]
    hasDateFilter: boolean
    periodMode: PeriodMode
    filters: FilterMeta[]
  }
  rows: Record<string, any>[]
  available: boolean
  company: ReportCompany | null
  generatedAt: string
  generatedBy: string
}

// Honours the configured currency (symbol/position/separators) via settings.
const currency = (n: number) => inr0(Number(n) || 0)

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"

function formatCell(value: any, col: ReportColumn) {
  if (value === null || value === undefined || value === "") return "—"
  if (col.money) return currency(value)
  return String(value)
}

// Sum the money columns so totals stay consistent across the table footer,
// CSV and PDF. Returns null when a report has no money columns to total.
function computeTotals(columns: ReportColumn[], rows: Record<string, any>[]) {
  const moneyCols = columns.filter((c) => c.money)
  if (moneyCols.length === 0 || rows.length === 0) return null
  const totals: Record<string, number> = {}
  for (const c of moneyCols) {
    totals[c.key] = rows.reduce((sum, r) => sum + (Number(r[c.key]) || 0), 0)
  }
  return totals
}

function reportUrl(key: string, from: string, to: string, filters: Record<string, string>) {
  const params = new URLSearchParams({ report: key })
  if (from) params.set("from", from)
  if (to) params.set("to", to)
  for (const [dim, value] of Object.entries(filters)) {
    if (value.trim()) params.set(`f_${dim}`, value.trim())
  }
  return `/api/finance/reports?${params.toString()}`
}

function activeFilterLabels(entry: CatalogueEntry, filters: Record<string, string>) {
  return entry.filters
    .filter((f) => (filters[f.dim] ?? "").trim())
    .map((f) => `${f.label}: ${filters[f.dim].trim()}`)
}

function ReportView({
  entry,
  from,
  to,
  filters,
  subtitle,
  periodLabel,
  filterLabels,
  pendingAction,
  onActionConsumed,
}: {
  entry: CatalogueEntry
  from: string
  to: string
  filters: Record<string, string>
  subtitle: string
  periodLabel: string
  filterLabels: string[]
  pendingAction: RowAction | null
  onActionConsumed: () => void
}) {
  const { data, isLoading, isValidating, mutate } = useSWR<ReportResponse>(
    reportUrl(entry.key, from, to, filters),
    fetcher,
    {
      keepPreviousData: true,
      // Live data: refresh when the tab regains focus or the network reconnects
      // so posted transactions surface without a manual reload.
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    },
  )

  const report = data?.report
  const rows = data?.rows ?? []
  const company = data?.company ?? null
  const generatedAt = data?.generatedAt ?? ""
  const generatedBy = data?.generatedBy ?? ""
  const totals = useMemo(
    () => (report ? computeTotals(report.columns, rows) : null),
    [report, rows],
  )

  const [viewOpen, setViewOpen] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)
  const [drillTarget, setDrillTarget] = useState<DrillTarget>(null)

  // Build the shared export payload so CSV / Excel / PDF all render identically
  // through the single Tally-style export engine.
  function exportPayload(): ReportExportPayload | null {
    if (!report) return null
    return {
      reportKey: entry.key,
      reportLabel: entry.label,
      reportDescription: entry.description,
      columns: report.columns,
      rows,
      company,
      subtitle,
      filterLabels,
      generatedAt,
      generatedBy,
    }
  }

  // Phase 19 — record a download in the report run log (best-effort, fire and
  // forget) so it shows up in the Download history alongside emailed reports.
  function logDownload(format: "PDF" | "Excel" | "CSV") {
    fetch("/api/finance/reports/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        report_key: entry.key,
        report_label: entry.label,
        format,
        period_label: periodLabel,
        filters_text: filterLabels.join(", "),
        row_count: rows.length,
      }),
    }).catch(() => {})
  }

  function downloadCsv() {
    const payload = exportPayload()
    if (payload) {
      exportReportCsv(payload)
      logDownload("CSV")
    }
  }

  async function downloadExcel() {
    const payload = exportPayload()
    if (payload) {
      await exportReportExcel(payload)
      logDownload("Excel")
    }
  }

  async function downloadPdf() {
    const payload = exportPayload()
    if (payload) {
      await exportReportPdf(payload)
      logDownload("PDF")
    }
  }

  // Run a per-row action queued from the report list. We wait until the data
  // for *this* report has loaded (keepPreviousData keeps the previous report's
  // rows during a switch, so guard on data.report.key) before acting.
  useEffect(() => {
    if (!pendingAction) return
    if (isLoading || !data || data.report.key !== entry.key) return
    switch (pendingAction) {
      case "view":
        setViewOpen(true)
        break
      case "email":
        setEmailOpen(true)
        break
      case "csv":
        if (rows.length > 0) downloadCsv()
        break
      case "excel":
        if (rows.length > 0) void downloadExcel()
        break
      case "pdf":
        if (rows.length > 0) void downloadPdf()
        break
    }
    onActionConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAction, isLoading, data, entry.key])

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="text-base">{entry.label}</CardTitle>
          <p className="text-sm text-muted-foreground">{entry.description}</p>
          {subtitle && <p className="text-xs font-medium text-muted-foreground">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="secondary">{rows.length} rows</Badge>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Refresh ${entry.label}`}
            onClick={() => mutate()}
          >
            <RefreshCw className={isValidating ? "animate-spin" : ""} />
          </Button>
          <Button variant="default" size="sm" onClick={() => setViewOpen(true)} disabled={!report}>
            <Eye data-icon="inline-start" />
            View
          </Button>
          <Button variant="outline" size="sm" onClick={downloadCsv} disabled={rows.length === 0}>
            <Download data-icon="inline-start" />
            CSV
          </Button>
          <Button variant="outline" size="sm" onClick={downloadExcel} disabled={rows.length === 0}>
            <FileSpreadsheet data-icon="inline-start" />
            Excel
          </Button>
          <Button variant="outline" size="sm" onClick={downloadPdf} disabled={rows.length === 0}>
            <FileText data-icon="inline-start" />
            PDF
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEmailOpen(true)} disabled={rows.length === 0}>
            <Mail data-icon="inline-start" />
            Email
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Generating report…</p>
        ) : data && !data.available ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No data source available for this report yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {report?.columns.map((c) => (
                    <TableHead key={c.key} className={c.align === "right" ? "text-right" : undefined}>
                      {c.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={report?.columns.length || 1}
                      className="py-6 text-center text-muted-foreground"
                    >
                      No records for the selected period.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row, i) => (
                    <TableRow key={i}>
                      {report?.columns.map((c) => (
                        <TableCell
                          key={c.key}
                          className={c.align === "right" ? "text-right tabular-nums" : undefined}
                        >
                          {formatCell(row[c.key], c)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
              </TableBody>
              {totals && rows.length > 0 && (
                <TableFooter>
                  <TableRow>
                    {report?.columns.map((c, i) => (
                      <TableCell
                        key={c.key}
                        className={c.align === "right" ? "text-right tabular-nums font-semibold" : "font-semibold"}
                      >
                        {i === 0 ? "Total" : totals[c.key] !== undefined ? currency(totals[c.key]) : ""}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableFooter>
              )}
            </Table>
          </div>
        )}
      </CardContent>

      {report && (
        <ReportViewDialog
          open={viewOpen}
          onClose={() => setViewOpen(false)}
          reportLabel={entry.label}
          reportDescription={entry.description}
          columns={report.columns}
          rows={rows}
          company={company as ReportCompany | null}
          subtitle={subtitle}
          generatedAt={generatedAt}
          filterLabels={filterLabels}
          onDownloadCsv={downloadCsv}
          onDownloadExcel={downloadExcel}
          onDownloadPdf={downloadPdf}
          onEmail={() => {
            setViewOpen(false)
            setEmailOpen(true)
          }}
          onDrill={(target) => setDrillTarget(target)}
        />
      )}

      <ReportEmailDialog
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        reportKey={entry.key}
        reportLabel={entry.label}
        reportDescription={entry.description}
        from={from}
        to={to}
        filters={filters}
        subtitle={subtitle}
        periodLabel={periodLabel}
        filterLabels={filterLabels}
        columns={report?.columns ?? []}
        rows={rows}
        company={company as ReportCompany | null}
        generatedAt={generatedAt}
        generatedBy={generatedBy}
      />

      <ReportDrillDrawer
        target={drillTarget}
        from={from}
        to={to}
        onClose={() => setDrillTarget(null)}
      />
    </Card>
  )
}

function PeriodControls({
  mode,
  period,
  setPeriod,
}: {
  mode: PeriodMode
  period: PeriodState
  setPeriod: (updater: (p: PeriodState) => PeriodState) => void
}) {
  const fys = useMemo(() => fyOptions(), [])
  const months = useMemo(() => monthOptions(), [])

  if (mode === "none") {
    return <p className="text-sm text-muted-foreground">This report is not time-filtered.</p>
  }

  if (mode === "asOn") {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="report-ason">
            As on date
          </label>
          <Input
            id="report-ason"
            type="date"
            value={period.asOn}
            onChange={(e) => setPeriod((p) => ({ ...p, asOn: e.target.value }))}
          />
          <p className="text-xs text-muted-foreground">Leave empty to include all data to date.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="report-preset">
          Period
        </label>
        <select
          id="report-preset"
          className={selectClass}
          value={period.preset}
          onChange={(e) => setPeriod((p) => ({ ...p, preset: e.target.value as PeriodPreset }))}
        >
          <option value="all">All time</option>
          <option value="fy">Financial Year</option>
          <option value="quarter">Quarter</option>
          <option value="month">Month</option>
          <option value="custom">Custom range</option>
        </select>
      </div>

      {(period.preset === "fy" || period.preset === "quarter") && (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="report-fy">
            Financial year
          </label>
          <select
            id="report-fy"
            className={selectClass}
            value={period.fy}
            onChange={(e) => setPeriod((p) => ({ ...p, fy: e.target.value }))}
          >
            {fys.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {period.preset === "quarter" && (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="report-quarter">
            Quarter
          </label>
          <select
            id="report-quarter"
            className={selectClass}
            value={period.quarter}
            onChange={(e) => setPeriod((p) => ({ ...p, quarter: e.target.value }))}
          >
            {QUARTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {period.preset === "month" && (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="report-month">
            Month
          </label>
          <select
            id="report-month"
            className={selectClass}
            value={period.month}
            onChange={(e) => setPeriod((p) => ({ ...p, month: e.target.value }))}
          >
            {months.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {period.preset === "custom" && (
        <>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="report-from">
              From date
            </label>
            <Input
              id="report-from"
              type="date"
              value={period.from}
              onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="report-to">
              To date
            </label>
            <Input
              id="report-to"
              type="date"
              value={period.to}
              onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))}
            />
          </div>
        </>
      )}
    </div>
  )
}

export function FinancialReportsClient() {
  const [view, setView] = useState<"reports" | "history">("reports")
  const [period, setPeriod] = useState<PeriodState>(defaultPeriod)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [reportKey, setReportKey] = useState<string>("")
  const [openGroup, setOpenGroup] = useState<string>("")
  const [pendingAction, setPendingAction] = useState<RowAction | null>(null)

  const { data, isLoading } = useSWR<{ reports: CatalogueEntry[] }>(
    "/api/finance/reports",
    fetcher,
  )

  const catalogue = data?.reports ?? []

  // Categories in catalogue order (first-seen), so the accounting groups keep
  // their intended sequence rather than being alphabetised.
  const groups = useMemo(() => {
    const map = new Map<string, CatalogueEntry[]>()
    for (const r of catalogue) {
      const list = map.get(r.group) ?? []
      list.push(r)
      map.set(r.group, list)
    }
    return Array.from(map, ([group, reports]) => ({ group, reports }))
  }, [catalogue])

  // Default selection + open the first category once the catalogue loads.
  useEffect(() => {
    if (reportKey || groups.length === 0) return
    const first = groups[0]
    setReportKey(first.reports[0]?.key ?? "")
    setOpenGroup(first.group)
  }, [reportKey, groups])

  const selected = catalogue.find((r) => r.key === reportKey)
  const periodMode: PeriodMode = selected?.periodMode ?? "range"
  const { from, to } = resolveRange(periodMode, period)

  const label = selected ? periodLabel(periodMode, period) : ""
  const subtitle = selected
    ? [label, ...activeFilterLabels(selected, filters)].filter(Boolean).join("  •  ")
    : ""

  const controlsActive =
    period.preset !== "all" ||
    Boolean(period.asOn) ||
    Object.values(filters).some((v) => v.trim())

  function toggleGroup(group: string) {
    setOpenGroup((prev) => (prev === group ? "" : group))
  }

  function pickReport(entry: CatalogueEntry) {
    setReportKey(entry.key)
    setOpenGroup(entry.group)
    // Filters are report-specific — clear them when switching reports.
    setFilters({})
  }

  // Per-row button: make this report the active one, then queue the action so
  // ReportView runs it once the report's data has loaded.
  function runReportAction(entry: CatalogueEntry, action: RowAction) {
    if (entry.key !== reportKey) pickReport(entry)
    setPendingAction(action)
  }

  function resetControls() {
    setPeriod(defaultPeriod())
    setFilters({})
  }

  return (
    <main className="space-y-8 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
            <FileBarChart className="size-5" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Finance management</p>
            <h1 className="text-3xl font-semibold tracking-tight">Financial Reports</h1>
          </div>
        </div>
        <div className="flex gap-1 rounded-md border p-1">
          {(["reports", "history"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`rounded px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                view === v ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/60"
              }`}
            >
              {v === "history" ? "Download & Email history" : "Reports"}
            </button>
          ))}
        </div>
      </div>

      {view === "history" ? (
        <ReportHistoryPanel />
      ) : (
        <>
      {/* Period + filters live at the top and apply to whichever report you
          view or export from the list below. */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Report controls</CardTitle>
          {controlsActive && (
            <Button variant="ghost" size="sm" onClick={resetControls}>
              <FilterX data-icon="inline-start" />
              Reset
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {!selected ? (
            <p className="text-sm text-muted-foreground">
              Select a report below to configure its period and filters.
            </p>
          ) : (
            <>
              <div className="space-y-4">
                <p className="text-xs font-medium text-muted-foreground">Period</p>
                <PeriodControls mode={periodMode} period={period} setPeriod={setPeriod} />
              </div>

              {selected.filters.length > 0 && (
                <div className="space-y-2 border-t pt-4">
                  <p className="text-xs font-medium text-muted-foreground">Filters</p>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {selected.filters.map((f) => (
                      <div key={f.dim} className="flex flex-col gap-1">
                        <label
                          className="text-xs font-medium text-muted-foreground"
                          htmlFor={`filter-${f.dim}`}
                        >
                          {f.label}
                        </label>
                        <Input
                          id={`filter-${f.dim}`}
                          value={filters[f.dim] ?? ""}
                          placeholder={`Filter by ${f.label.toLowerCase()}`}
                          onChange={(e) =>
                            setFilters((prev) => ({ ...prev, [f.dim]: e.target.value }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Category → report picker. Each report row carries its own action
          buttons (View / CSV / Excel / PDF / Email) that act on that report
          using the period and filters set above. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reports</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="py-4 text-sm text-muted-foreground">Loading report catalogue…</p>
          ) : groups.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No reports available.</p>
          ) : (
            <div className="space-y-2">
              {groups.map(({ group, reports }) => {
                const isOpen = openGroup === group
                return (
                  <div key={group} className="rounded-md border">
                    <button
                      type="button"
                      onClick={() => toggleGroup(group)}
                      className="flex w-full items-center gap-2 px-3 py-3 text-left"
                      aria-expanded={isOpen}
                    >
                      {isOpen ? (
                        <ChevronDown className="size-4 shrink-0" />
                      ) : (
                        <ChevronRight className="size-4 shrink-0" />
                      )}
                      <span className="text-sm font-semibold">{group}</span>
                      <Badge variant="secondary" className="ml-auto">
                        {reports.length} report{reports.length === 1 ? "" : "s"}
                      </Badge>
                    </button>
                    {isOpen && (
                      <ul className="border-t p-1">
                        {reports.map((r) => {
                          const active = r.key === reportKey
                          return (
                            <li key={r.key}>
                              <div
                                className={`flex flex-col gap-2 rounded-md px-3 py-2 transition-colors lg:flex-row lg:items-center lg:justify-between ${
                                  active ? "bg-primary/10" : "hover:bg-muted/60"
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={() => pickReport(r)}
                                  aria-pressed={active}
                                  className="flex flex-1 flex-col gap-0.5 text-left"
                                >
                                  <span
                                    className={`text-sm font-medium ${active ? "text-primary" : ""}`}
                                  >
                                    {r.label}
                                  </span>
                                  <span className="text-xs text-muted-foreground">
                                    {r.description}
                                  </span>
                                </button>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <Button
                                    variant="default"
                                    size="sm"
                                    onClick={() => runReportAction(r, "view")}
                                  >
                                    <Eye data-icon="inline-start" />
                                    View
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => runReportAction(r, "csv")}
                                  >
                                    <Download data-icon="inline-start" />
                                    CSV
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => runReportAction(r, "excel")}
                                  >
                                    <FileSpreadsheet data-icon="inline-start" />
                                    Excel
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => runReportAction(r, "pdf")}
                                  >
                                    <FileText data-icon="inline-start" />
                                    PDF
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => runReportAction(r, "email")}
                                  >
                                    <Mail data-icon="inline-start" />
                                    Email
                                  </Button>
                                </div>
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading report catalogue…</p>
      ) : selected ? (
        <ReportView
          entry={selected}
          from={from}
          to={to}
          filters={filters}
          subtitle={subtitle}
          periodLabel={label}
          filterLabels={activeFilterLabels(selected, filters)}
          pendingAction={pendingAction}
          onActionConsumed={() => setPendingAction(null)}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Select a category and report to begin.</p>
      )}
        </>
      )}
    </main>
  )
}
