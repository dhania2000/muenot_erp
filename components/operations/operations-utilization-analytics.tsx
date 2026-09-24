"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { ExcelExportButton } from "@/components/excel-export-button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import { Info } from "lucide-react"
import {
  summarizeUtilization,
  type UtilizationRow,
  type UtilizationStatus,
} from "@/lib/operations-utilization"

const STATUS_VARIANT: Record<UtilizationStatus, "default" | "secondary" | "destructive" | "outline"> = {
  Optimal: "default",
  "Over-allocated": "destructive",
  "Under-utilized": "secondary",
  Idle: "outline",
  "No Capacity": "outline",
}

function formatHours(value: unknown): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return "—"
  return `${n.toLocaleString("en-IN", { maximumFractionDigits: 1 })}h`
}
function formatPercent(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) ? `${n.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%` : "—"
}

export function OperationsUtilizationAnalytics() {
  const { data, isLoading } = useSWR<{ rows: UtilizationRow[] }>(
    "/api/operations/utilization-analytics",
    fetcher,
    { refreshInterval: 30000 },
  )
  const allRows = useMemo(() => data?.rows ?? [], [data])

  const periods = useMemo(
    () => Array.from(new Set(allRows.map((r) => r.period).filter(Boolean))).sort((a, b) => b.localeCompare(a)),
    [allRows],
  )
  const [period, setPeriod] = useState<string>("all")

  const rows = useMemo(
    () => (period === "all" ? allRows : allRows.filter((r) => r.period === period)),
    [allRows, period],
  )
  const summary = useMemo(() => summarizeUtilization(rows), [rows])

  const cards = [
    { label: "Available Hours", value: formatHours(summary.availableHours) },
    { label: "Allocated Hours", value: formatHours(summary.allocatedHours) },
    { label: "Actual Hours", value: formatHours(summary.actualHours) },
    { label: "Billable Hours", value: formatHours(summary.billableHours) },
    { label: "Utilization", value: formatPercent(summary.utilizationPercent) },
  ]

  return (
    <main className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Operations analytics</p>
          <h1 className="text-3xl font-semibold tracking-tight">Resource Utilization</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Available, allocated, actual and billable hours per resource, with utilization derived
            live from approved timesheets.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="All periods" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All periods</SelectItem>
              {periods.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ExcelExportButton
            rows={rows}
            filename={`operations-utilization${period === "all" ? "" : `-${period}`}`}
            columns={[
              { header: "Resource", value: (r: UtilizationRow) => r.resource_name },
              { header: "Period", value: (r: UtilizationRow) => r.period },
              { header: "Available Hours", value: (r: UtilizationRow) => r.availableHours },
              { header: "Allocated Hours", value: (r: UtilizationRow) => r.allocatedHours },
              { header: "Actual Hours", value: (r: UtilizationRow) => r.actualHours },
              { header: "Billable Hours", value: (r: UtilizationRow) => r.billableHours },
              { header: "Utilization %", value: (r: UtilizationRow) => r.utilizationPercent },
              { header: "Allocation %", value: (r: UtilizationRow) => r.allocationPercent },
              { header: "Billable %", value: (r: UtilizationRow) => r.billablePercent },
              { header: "Status", value: (r: UtilizationRow) => r.status },
            ]}
          />
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <span>
          Source: approved Operations timesheets, Resource capacity and active Allocations. This is a
          read-only report; it reconciles to timesheet hours and updates automatically.
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {cards.map((k) => (
          <Card key={k.label}>
            <CardContent className="flex flex-col gap-1 pt-6">
              <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
              <span className="text-2xl font-semibold tracking-tight tabular-nums">{k.value}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <section className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Resource</TableHead>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead className="text-right">Allocated</TableHead>
              <TableHead className="text-right">Actual</TableHead>
              <TableHead className="text-right">Billable</TableHead>
              <TableHead className="w-[180px]">Utilization</TableHead>
              <TableHead className="text-right">Billable %</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={9} className="p-8 text-center text-muted-foreground">
                  Loading utilization…
                </TableCell>
              </TableRow>
            )}
            {!isLoading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="p-8 text-center text-muted-foreground">
                  No data yet. This report populates automatically as approved timesheets are recorded.
                </TableCell>
              </TableRow>
            )}
            {rows.map((row, i) => (
              <TableRow key={`${row.resource_id}-${row.period}-${i}`}>
                <TableCell className="font-medium">{row.resource_name}</TableCell>
                <TableCell className="text-muted-foreground tabular-nums">{row.period || "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{formatHours(row.availableHours)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatHours(row.allocatedHours)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatHours(row.actualHours)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatHours(row.billableHours)}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Progress value={Math.min(100, row.utilizationPercent)} className="h-2" />
                    <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {formatPercent(row.utilizationPercent)}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatPercent(row.billablePercent)}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[row.status] ?? "outline"}>{row.status}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </main>
  )
}
