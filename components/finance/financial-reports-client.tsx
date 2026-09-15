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
  FileBarChart,
  FileText,
  FilterX,
  RefreshCw,
} from "lucide-react"
import { inr0 } from "@/lib/finance-calc"
import type { PeriodMode } from "@/lib/finance-reports"
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

// Plain-text cell used for CSV / PDF (no em-dash placeholder).
function plainCell(value: any, col: ReportColumn) {
  if (value === null || value === undefined || value === "") return ""
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
}: {
  entry: CatalogueEntry
  from: string
  to: string
  filters: Record<string, string>
  subtitle: string
}) {
  const { data, isLoading, isValidating, mutate } = useSWR<ReportResponse>(
    reportUrl(entry.key, from, to, filters),
    fetcher,
    { keepPreviousData: true },
  )

  const report = data?.report
  const rows = data?.rows ?? []
  const totals = useMemo(
    () => (report ? computeTotals(report.columns, rows) : null),
    [report, rows],
  )

  function downloadCsv() {
    if (!report) return
    const escape = (v: any) => {
      const s = v === null || v === undefined ? "" : String(v)
      return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
    }
    const lines: string[] = []
    if (subtitle) lines.push(escape(subtitle))
    lines.push(report.columns.map((c) => escape(c.label)).join(","))
    for (const row of rows) {
      lines.push(report.columns.map((c) => escape(plainCell(row[c.key], c))).join(","))
    }
    if (totals) {
      lines.push(
        report.columns
          .map((c, i) => escape(i === 0 ? "Total" : totals[c.key] !== undefined ? currency(totals[c.key]) : ""))
          .join(","),
      )
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${entry.key}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function downloadPdf() {
    if (!report) return
    const { jsPDF } = await import("jspdf")
    const autoTable = (await import("jspdf-autotable")).default
    const doc = new jsPDF({ orientation: report.columns.length > 6 ? "landscape" : "portrait" })

    doc.setFontSize(14)
    doc.text(entry.label, 14, 16)
    if (subtitle) {
      doc.setFontSize(9)
      doc.setTextColor(120)
      doc.text(subtitle, 14, 22)
    }

    const columnStyles: Record<number, any> = {}
    report.columns.forEach((c, i) => {
      if (c.align === "right" || c.money) columnStyles[i] = { halign: "right" }
    })

    autoTable(doc, {
      startY: subtitle ? 27 : 22,
      head: [report.columns.map((c) => c.label)],
      body: rows.map((row) => report.columns.map((c) => plainCell(row[c.key], c))),
      foot: totals
        ? [
            report.columns.map((c, i) =>
              i === 0 ? "Total" : totals[c.key] !== undefined ? currency(totals[c.key]) : "",
            ),
          ]
        : undefined,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [31, 41, 55], textColor: 255 },
      footStyles: { fillColor: [243, 244, 246], textColor: 17, fontStyle: "bold" },
      columnStyles,
    })

    doc.save(`${entry.key}.pdf`)
  }

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
          <Button variant="outline" size="sm" onClick={downloadCsv} disabled={rows.length === 0}>
            <Download data-icon="inline-start" />
            CSV
          </Button>
          <Button variant="outline" size="sm" onClick={downloadPdf} disabled={rows.length === 0}>
            <FileText data-icon="inline-start" />
            PDF
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
  const [period, setPeriod] = useState<PeriodState>(defaultPeriod)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [reportKey, setReportKey] = useState<string>("")
  const [openGroup, setOpenGroup] = useState<string>("")

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
      </div>

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
          {/* Category → report picker, rendered as collapsible cards (one per
              category) to mirror the Chart of Accounts layout. */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Category</p>
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
                                <button
                                  type="button"
                                  onClick={() => pickReport(r)}
                                  aria-pressed={active}
                                  className={`flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors ${
                                    active ? "bg-primary/10 text-primary" : "hover:bg-muted/60"
                                  }`}
                                >
                                  <span className="text-sm font-medium">{r.label}</span>
                                  <span className="text-xs text-muted-foreground">{r.description}</span>
                                </button>
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
          </div>

          {selected && (
            <div className="space-y-4 border-t pt-4">
              <p className="text-xs font-medium text-muted-foreground">Period</p>
              <PeriodControls mode={periodMode} period={period} setPeriod={setPeriod} />
            </div>
          )}

          {selected && selected.filters.length > 0 && (
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
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading report catalogue…</p>
      ) : selected ? (
        <ReportView entry={selected} from={from} to={to} filters={filters} subtitle={subtitle} />
      ) : (
        <p className="text-sm text-muted-foreground">Select a category and report to begin.</p>
      )}
    </main>
  )
}
