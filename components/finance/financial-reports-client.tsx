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
import { Download, FileBarChart, FilterX, RefreshCw } from "lucide-react"
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
  const [group, setGroup] = useState<string>("")
  const [reportKey, setReportKey] = useState<string>("")

  const { data, isLoading } = useSWR<{ reports: CatalogueEntry[] }>(
    "/api/finance/reports",
    fetcher,
  )

  const catalogue = data?.reports ?? []

  // Categories in catalogue order (first-seen), so the accounting groups keep
  // their intended sequence rather than being alphabetised.
  const groups = useMemo(() => {
    const seen: string[] = []
    for (const r of catalogue) if (!seen.includes(r.group)) seen.push(r.group)
    return seen
  }, [catalogue])

  const reportsInGroup = useMemo(
    () => catalogue.filter((r) => r.group === group),
    [catalogue, group],
  )

  // Default to the first category once the catalogue loads.
  useEffect(() => {
    if (!group && groups.length > 0) setGroup(groups[0])
  }, [group, groups])

  // Keep the selected report valid whenever the category changes.
  useEffect(() => {
    if (reportsInGroup.length === 0) {
      if (reportKey) setReportKey("")
      return
    }
    if (!reportsInGroup.some((r) => r.key === reportKey)) {
      setReportKey(reportsInGroup[0].key)
    }
  }, [reportsInGroup, reportKey])

  const selected = reportsInGroup.find((r) => r.key === reportKey)
  const rangeActive = Boolean(range.from || range.to)

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
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="report-group">
              Category
            </label>
            <select
              id="report-group"
              className="h-10 rounded-md border bg-background px-3 text-sm"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              disabled={isLoading || groups.length === 0}
            >
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="report-name">
              Report
            </label>
            <select
              id="report-name"
              className="h-10 rounded-md border bg-background px-3 text-sm"
              value={reportKey}
              onChange={(e) => setReportKey(e.target.value)}
              disabled={reportsInGroup.length === 0}
            >
              {reportsInGroup.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
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
