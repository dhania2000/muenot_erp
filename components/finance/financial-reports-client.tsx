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
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileBarChart,
  FilterX,
  RefreshCw,
} from "lucide-react"
import { inr0 } from "@/lib/finance-calc"

type ReportColumn = {
  key: string
  label: string
  align?: "left" | "right"
  money?: boolean
}

type CatalogueEntry = {
  key: string
  label: string
  group: string
  description: string
}

type ReportResponse = {
  report: {
    key: string
    label: string
    group: string
    description: string
    columns: ReportColumn[]
    hasDateFilter: boolean
  }
  rows: Record<string, any>[]
  available: boolean
}

// Honours the configured currency (symbol/position/separators) via settings.
const currency = (n: number) => inr0(Number(n) || 0)

function formatCell(value: any, col: ReportColumn) {
  if (value === null || value === undefined || value === "") return "—"
  if (col.money) return currency(value)
  return String(value)
}

function reportUrl(key: string, from: string, to: string) {
  const params = new URLSearchParams({ report: key })
  if (from) params.set("from", from)
  if (to) params.set("to", to)
  return `/api/finance/reports?${params.toString()}`
}

function toCsv(report: ReportResponse["report"], rows: Record<string, any>[]) {
  const escape = (v: any) => {
    const s = v === null || v === undefined ? "" : String(v)
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  const header = report.columns.map((c) => escape(c.label)).join(",")
  const body = rows
    .map((row) => report.columns.map((c) => escape(row[c.key])).join(","))
    .join("\n")
  return `${header}\n${body}`
}

function ReportView({
  entry,
  from,
  to,
}: {
  entry: CatalogueEntry
  from: string
  to: string
}) {
  const { data, isLoading, isValidating, mutate } = useSWR<ReportResponse>(
    reportUrl(entry.key, from, to),
    fetcher,
    { keepPreviousData: true },
  )

  const report = data?.report
  const rows = data?.rows ?? []

  function downloadCsv() {
    if (!report) return
    const csv = toCsv(report, rows)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${entry.key}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="text-base">{entry.label}</CardTitle>
          <p className="text-sm text-muted-foreground">{entry.description}</p>
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
          <Button
            variant="outline"
            size="sm"
            onClick={downloadCsv}
            disabled={rows.length === 0}
          >
            <Download data-icon="inline-start" />
            CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Generating report…
          </p>
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
                    <TableHead
                      key={c.key}
                      className={c.align === "right" ? "text-right" : undefined}
                    >
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
                          className={
                            c.align === "right"
                              ? "text-right tabular-nums"
                              : undefined
                          }
                        >
                          {formatCell(row[c.key], c)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

const emptyRange = { from: "", to: "" }

export function FinancialReportsClient() {
  const [range, setRange] = useState(emptyRange)
  const [reportKey, setReportKey] = useState<string>("")
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())

  const { data, isLoading } = useSWR<{ reports: CatalogueEntry[] }>(
    "/api/finance/reports",
    fetcher,
  )

  const catalogue = data?.reports ?? []

  // Categories in catalogue order (first-seen), so the accounting groups keep
  // their intended sequence rather than being alphabetised. Each category maps
  // to the reports it contains, so it can render as one collapsible card.
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
    setOpenGroups(new Set([first.group]))
  }, [reportKey, groups])

  const selected = catalogue.find((r) => r.key === reportKey)
  const rangeActive = Boolean(range.from || range.to)

  function toggleGroup(group: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  function pickReport(entry: CatalogueEntry) {
    setReportKey(entry.key)
    setOpenGroups((prev) => new Set(prev).add(entry.group))
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
          {rangeActive && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRange(emptyRange)}
            >
              <FilterX data-icon="inline-start" />
              Reset dates
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
                  const isOpen = openGroups.has(group)
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
                                    active
                                      ? "bg-primary/10 text-primary"
                                      : "hover:bg-muted/60"
                                  }`}
                                >
                                  <span className="text-sm font-medium">{r.label}</span>
                                  <span className="text-xs text-muted-foreground">
                                    {r.description}
                                  </span>
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="report-from">
                From date
              </label>
              <Input
                id="report-from"
                type="date"
                value={range.from}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="report-to">
                To date
              </label>
              <Input
                id="report-to"
                type="date"
                value={range.to}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading report catalogue…</p>
      ) : selected ? (
        <ReportView entry={selected} from={range.from} to={range.to} />
      ) : (
        <p className="text-sm text-muted-foreground">Select a category and report to begin.</p>
      )}
    </main>
  )
}
