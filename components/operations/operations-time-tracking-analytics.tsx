"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { ExcelExportButton } from "@/components/excel-export-button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
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
import type {
  ApprovalBreakdown,
  PayrollRow,
  TimeGroupRow,
  TimeSummary,
} from "@/lib/operations-time-tracking"

type Report = {
  summary: TimeSummary
  byResource: TimeGroupRow[]
  byProject: TimeGroupRow[]
  byClient: TimeGroupRow[]
  payroll: PayrollRow[]
  approval: ApprovalBreakdown
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
function formatMoney(value: unknown): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return "—"
  return n.toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })
}

function GroupTable({
  rows,
  labelHead,
  emptyLabel,
}: {
  rows: TimeGroupRow[]
  labelHead: string
  emptyLabel: string
}) {
  return (
    <section className="overflow-x-auto rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{labelHead}</TableHead>
            <TableHead>Period</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead className="text-right">Regular</TableHead>
            <TableHead className="text-right">Overtime</TableHead>
            <TableHead className="text-right">Billable</TableHead>
            <TableHead className="text-right">Non-billable</TableHead>
            <TableHead className="w-[160px]">Billable %</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="p-8 text-center text-muted-foreground">
                {emptyLabel}
              </TableCell>
            </TableRow>
          )}
          {rows.map((row, i) => (
            <TableRow key={`${row.key}-${row.period}-${i}`}>
              <TableCell className="font-medium">{row.label}</TableCell>
              <TableCell className="tabular-nums text-muted-foreground">{row.period || "—"}</TableCell>
              <TableCell className="text-right tabular-nums">{formatHours(row.totalHours)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatHours(row.regularHours)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {row.overtimeHours > 0 ? (
                  <Badge variant="secondary">{formatHours(row.overtimeHours)}</Badge>
                ) : (
                  <span className="text-muted-foreground">{formatHours(row.overtimeHours)}</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatHours(row.billableHours)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatHours(row.nonBillableHours)}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Progress value={Math.min(100, row.billablePercent)} className="h-2" />
                  <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {formatPercent(row.billablePercent)}
                  </span>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  )
}

export function OperationsTimeTrackingAnalytics() {
  const [period, setPeriod] = useState<string>("all")
  const [scope, setScope] = useState<"approved" | "all">("approved")

  const params = new URLSearchParams()
  if (period !== "all") params.set("period", period)
  if (scope === "all") params.set("scope", "all")
  const queryString = params.toString()

  const { data, isLoading } = useSWR<Report>(
    `/api/operations/time-tracking${queryString ? `?${queryString}` : ""}`,
    fetcher,
    { refreshInterval: 30000 },
  )

  // Period options come from whatever periods the roll-ups reference.
  const { data: allData } = useSWR<Report>("/api/operations/time-tracking?scope=all", fetcher)
  const periods = useMemo(() => {
    const set = new Set<string>()
    for (const r of allData?.byResource ?? []) if (r.period) set.add(r.period)
    return Array.from(set).sort((a, b) => b.localeCompare(a))
  }, [allData])

  const summary = data?.summary
  const approval = data?.approval

  const cards = [
    { label: "Total Hours", value: formatHours(summary?.totalHours) },
    { label: "Regular Hours", value: formatHours(summary?.regularHours) },
    { label: "Overtime Hours", value: formatHours(summary?.overtimeHours) },
    { label: "Billable Hours", value: formatHours(summary?.billableHours) },
    { label: "Billable %", value: formatPercent(summary?.billablePercent) },
  ]

  const payrollTotal = useMemo(
    () => (data?.payroll ?? []).reduce((sum, p) => sum + p.totalPay, 0),
    [data],
  )

  return (
    <main className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Operations analytics</p>
          <h1 className="text-3xl font-semibold tracking-tight">Time Tracking</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Project and client time, billable vs non-billable split, overtime and payroll/billing —
            derived live from timesheets so it always reconciles to the source records.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={scope} onValueChange={(v) => setScope(v as "approved" | "all")}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="approved">Approved only</SelectItem>
              <SelectItem value="all">All statuses</SelectItem>
            </SelectContent>
          </Select>
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
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <span>
          Source: Operations timesheets, enriched with client from Projects and cost rates from
          Resources. Roll-ups and payroll use {scope === "approved" ? "approved" : "all"} time; overtime
          is hours beyond a standard working day. Read-only — it reconciles to timesheet hours.
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {cards.map((k) => (
          <Card key={k.label}>
            <CardContent className="flex flex-col gap-1 pt-6">
              <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
              <span className="text-2xl font-semibold tracking-tight tabular-nums">
                {isLoading ? "…" : k.value}
              </span>
            </CardContent>
          </Card>
        ))}
      </div>

      {approval && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[
            { label: "Draft", hours: approval.draftHours, count: approval.draftCount },
            { label: "Submitted", hours: approval.submittedHours, count: approval.submittedCount },
            { label: "Approved", hours: approval.approvedHours, count: approval.approvedCount },
            { label: "Rejected", hours: approval.rejectedHours, count: approval.rejectedCount },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="flex items-center justify-between gap-2 pt-6">
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">{s.label}</span>
                  <span className="text-lg font-semibold tabular-nums">{formatHours(s.hours)}</span>
                </div>
                <Badge variant="outline">{s.count}</Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Tabs defaultValue="resource" className="space-y-4">
        <TabsList>
          <TabsTrigger value="resource">By Resource</TabsTrigger>
          <TabsTrigger value="project">By Project</TabsTrigger>
          <TabsTrigger value="client">By Client</TabsTrigger>
          <TabsTrigger value="payroll">Payroll &amp; Billing</TabsTrigger>
        </TabsList>

        <TabsContent value="resource" className="space-y-3">
          <div className="flex justify-end">
            <ExcelExportButton
              rows={data?.byResource ?? []}
              filename="time-tracking-by-resource"
              columns={[
                { header: "Resource", value: (r: TimeGroupRow) => r.label },
                { header: "Period", value: (r: TimeGroupRow) => r.period },
                { header: "Total Hours", value: (r: TimeGroupRow) => r.totalHours },
                { header: "Regular Hours", value: (r: TimeGroupRow) => r.regularHours },
                { header: "Overtime Hours", value: (r: TimeGroupRow) => r.overtimeHours },
                { header: "Billable Hours", value: (r: TimeGroupRow) => r.billableHours },
                { header: "Non-billable Hours", value: (r: TimeGroupRow) => r.nonBillableHours },
                { header: "Billable %", value: (r: TimeGroupRow) => r.billablePercent },
              ]}
            />
          </div>
          <GroupTable
            rows={data?.byResource ?? []}
            labelHead="Resource"
            emptyLabel={isLoading ? "Loading…" : "No time recorded yet."}
          />
        </TabsContent>

        <TabsContent value="project" className="space-y-3">
          <div className="flex justify-end">
            <ExcelExportButton
              rows={data?.byProject ?? []}
              filename="time-tracking-by-project"
              columns={[
                { header: "Project", value: (r: TimeGroupRow) => r.label },
                { header: "Period", value: (r: TimeGroupRow) => r.period },
                { header: "Total Hours", value: (r: TimeGroupRow) => r.totalHours },
                { header: "Billable Hours", value: (r: TimeGroupRow) => r.billableHours },
                { header: "Non-billable Hours", value: (r: TimeGroupRow) => r.nonBillableHours },
                { header: "Billable %", value: (r: TimeGroupRow) => r.billablePercent },
              ]}
            />
          </div>
          <GroupTable
            rows={data?.byProject ?? []}
            labelHead="Project"
            emptyLabel={isLoading ? "Loading…" : "No project time recorded yet."}
          />
        </TabsContent>

        <TabsContent value="client" className="space-y-3">
          <div className="flex justify-end">
            <ExcelExportButton
              rows={data?.byClient ?? []}
              filename="time-tracking-by-client"
              columns={[
                { header: "Client", value: (r: TimeGroupRow) => r.label },
                { header: "Period", value: (r: TimeGroupRow) => r.period },
                { header: "Total Hours", value: (r: TimeGroupRow) => r.totalHours },
                { header: "Billable Hours", value: (r: TimeGroupRow) => r.billableHours },
                { header: "Non-billable Hours", value: (r: TimeGroupRow) => r.nonBillableHours },
                { header: "Billable %", value: (r: TimeGroupRow) => r.billablePercent },
              ]}
            />
          </div>
          <GroupTable
            rows={data?.byClient ?? []}
            labelHead="Client"
            emptyLabel={isLoading ? "Loading…" : "No client time recorded yet."}
          />
        </TabsContent>

        <TabsContent value="payroll" className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Total labour cost:{" "}
              <span className="font-semibold text-foreground tabular-nums">{formatMoney(payrollTotal)}</span>{" "}
              <span className="text-xs">(overtime paid at 1.5×)</span>
            </p>
            <ExcelExportButton
              rows={data?.payroll ?? []}
              filename="time-tracking-payroll"
              columns={[
                { header: "Resource", value: (r: PayrollRow) => r.resource_name },
                { header: "Period", value: (r: PayrollRow) => r.period },
                { header: "Hourly Rate", value: (r: PayrollRow) => r.hourlyRate },
                { header: "Regular Hours", value: (r: PayrollRow) => r.regularHours },
                { header: "Overtime Hours", value: (r: PayrollRow) => r.overtimeHours },
                { header: "Regular Pay", value: (r: PayrollRow) => r.regularPay },
                { header: "Overtime Pay", value: (r: PayrollRow) => r.overtimePay },
                { header: "Total Pay", value: (r: PayrollRow) => r.totalPay },
              ]}
            />
          </div>
          <section className="overflow-x-auto rounded-xl border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resource</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Rate/hr</TableHead>
                  <TableHead className="text-right">Regular</TableHead>
                  <TableHead className="text-right">Overtime</TableHead>
                  <TableHead className="text-right">Regular Pay</TableHead>
                  <TableHead className="text-right">Overtime Pay</TableHead>
                  <TableHead className="text-right">Total Pay</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.payroll ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="p-8 text-center text-muted-foreground">
                      {isLoading ? "Loading…" : "No payable time yet. Set resource cost rates to see pay."}
                    </TableCell>
                  </TableRow>
                )}
                {(data?.payroll ?? []).map((row, i) => (
                  <TableRow key={`${row.resource_id}-${row.period}-${i}`}>
                    <TableCell className="font-medium">{row.resource_name}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{row.period || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(row.hourlyRate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatHours(row.regularHours)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatHours(row.overtimeHours)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(row.regularPay)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(row.overtimePay)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatMoney(row.totalPay)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        </TabsContent>
      </Tabs>
    </main>
  )
}
