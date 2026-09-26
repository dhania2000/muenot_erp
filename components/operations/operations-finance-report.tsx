"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ExcelExportButton } from "@/components/excel-export-button"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import { Info } from "lucide-react"

type View = "project_cost" | "resource_cost" | "vendor_cost" | "budget_vs_actual" | "profitability"

type Column = {
  key: string
  label: string
  align?: "left" | "right"
  money?: boolean
  numeric?: boolean
  badge?: boolean
}

const currency = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
})

function formatMoney(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) ? currency.format(n) : "—"
}
function formatNumber(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString("en-IN") : "—"
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Paid: "default",
  "Partially Paid": "secondary",
  Unpaid: "destructive",
  "Under Budget": "default",
  "At Risk": "secondary",
  "Over Budget": "destructive",
  "No Budget": "outline",
  Profitable: "default",
  "Low Margin": "secondary",
  Loss: "destructive",
  "No Revenue": "outline",
}

const VIEWS: Record<
  View,
  { title: string; subtitle: string; source: string; columns: Column[]; summary: (rows: any[]) => { label: string; value: string }[] }
> = {
  vendor_cost: {
    title: "Vendor Cost",
    subtitle: "Vendor spend per project, derived live from Finance purchase bills.",
    source: "Source: Finance → Purchase Bills. This is a read-only report; edit the underlying bills in Finance.",
    columns: [
      { key: "vendor_name", label: "Vendor" },
      { key: "project_name", label: "Project" },
      { key: "bill_count", label: "Bills", align: "right", numeric: true },
      { key: "invoice_amount", label: "Invoiced", align: "right", money: true },
      { key: "paid_amount", label: "Paid", align: "right", money: true },
      { key: "outstanding_amount", label: "Outstanding", align: "right", money: true },
      { key: "payment_status", label: "Status", badge: true },
    ],
    summary: (rows) => [
      { label: "Vendors × Projects", value: formatNumber(rows.length) },
      { label: "Total Invoiced", value: formatMoney(rows.reduce((s, r) => s + Number(r.invoice_amount || 0), 0)) },
      { label: "Total Paid", value: formatMoney(rows.reduce((s, r) => s + Number(r.paid_amount || 0), 0)) },
      { label: "Outstanding", value: formatMoney(rows.reduce((s, r) => s + Number(r.outstanding_amount || 0), 0)) },
    ],
  },
  resource_cost: {
    title: "Resource Cost",
    subtitle: "Labour cost per resource per project, from approved timesheets × resource cost rate.",
    source: "Source: Operations → approved Timesheets and the Resources master cost rate. Read-only report.",
    columns: [
      { key: "resource_name", label: "Resource" },
      { key: "project_name", label: "Project" },
      { key: "hours", label: "Approved Hrs", align: "right", numeric: true },
      { key: "billable_hours", label: "Billable Hrs", align: "right", numeric: true },
      { key: "hourly_rate", label: "Rate / Hr", align: "right", money: true },
      { key: "total_cost", label: "Total Cost", align: "right", money: true },
    ],
    summary: (rows) => [
      { label: "Resource × Projects", value: formatNumber(rows.length) },
      { label: "Approved Hours", value: formatNumber(Math.round(rows.reduce((s, r) => s + Number(r.hours || 0), 0))) },
      { label: "Labour Cost", value: formatMoney(rows.reduce((s, r) => s + Number(r.total_cost || 0), 0)) },
    ],
  },
  project_cost: {
    title: "Project Cost",
    subtitle: "Actual cost per project by category — vendor bills, expenses and labour.",
    source: "Source: Finance purchase bills + expenses and approved timesheet labour. Read-only report.",
    columns: [
      { key: "project_name", label: "Project" },
      { key: "cost_category", label: "Cost Category" },
      { key: "actual_cost", label: "Actual Cost", align: "right", money: true },
    ],
    summary: (rows) => [
      { label: "Projects", value: formatNumber(new Set(rows.map((r) => r.project_name)).size) },
      { label: "Total Actual Cost", value: formatMoney(rows.filter((r) => r.cost_category === "Total").reduce((s, r) => s + Number(r.actual_cost || 0), 0)) },
    ],
  },
  budget_vs_actual: {
    title: "Budget vs Actual",
    subtitle: "Planned project budget against derived actual spend.",
    source: "Source: Project budget (Projects master) vs derived actuals (bills + expenses + labour). Read-only report.",
    columns: [
      { key: "project_name", label: "Project" },
      { key: "budget_amount", label: "Budget", align: "right", money: true },
      { key: "actual_amount", label: "Actual", align: "right", money: true },
      { key: "variance", label: "Variance", align: "right", money: true },
      { key: "variance_percent", label: "Variance %", align: "right" },
      { key: "status", label: "Status", badge: true },
    ],
    summary: (rows) => [
      { label: "Projects", value: formatNumber(rows.length) },
      { label: "Total Budget", value: formatMoney(rows.reduce((s, r) => s + Number(r.budget_amount || 0), 0)) },
      { label: "Total Actual", value: formatMoney(rows.reduce((s, r) => s + Number(r.actual_amount || 0), 0)) },
      { label: "Over Budget", value: formatNumber(rows.filter((r) => r.status === "Over Budget").length) },
    ],
  },
  profitability: {
    title: "Project Profitability",
    subtitle: "Invoiced revenue against derived actual cost, with margin, budget burn and delivery progress.",
    source: "Source: Sales invoices (excl. cancelled/draft/proforma) vs bills + expenses + labour. Read-only report.",
    columns: [
      { key: "project_name", label: "Project" },
      { key: "revenue", label: "Revenue", align: "right", money: true },
      { key: "actual_cost", label: "Cost", align: "right", money: true },
      { key: "gross_profit", label: "Gross Profit", align: "right", money: true },
      { key: "margin_percent", label: "Margin %", align: "right" },
      { key: "budget_used_percent", label: "Budget Used %", align: "right" },
      { key: "progress_percent", label: "Progress %", align: "right" },
      { key: "status", label: "Status", badge: true },
    ],
    summary: (rows) => {
      const revenue = rows.reduce((s, r) => s + Number(r.revenue || 0), 0)
      const profit = rows.reduce((s, r) => s + Number(r.gross_profit || 0), 0)
      return [
        { label: "Total Revenue", value: formatMoney(revenue) },
        { label: "Gross Profit", value: formatMoney(profit) },
        { label: "Blended Margin", value: revenue > 0 ? `${Math.round((profit / revenue) * 1000) / 10}%` : "—" },
        { label: "Loss-making", value: formatNumber(rows.filter((r) => r.status === "Loss").length) },
      ]
    },
  },
}

const PERCENT_KEYS = new Set(["variance_percent", "margin_percent", "budget_used_percent", "progress_percent"])

function renderCell(col: Column, row: any) {
  const value = row[col.key]
  if (col.badge) {
    return <Badge variant={STATUS_VARIANT[String(value)] ?? "outline"}>{value ?? "—"}</Badge>
  }
  if (col.money) return formatMoney(value)
  if (PERCENT_KEYS.has(col.key)) {
    const n = value == null ? Number.NaN : Number(value)
    return Number.isFinite(n) ? `${n}%` : "—"
  }
  if (col.numeric) return formatNumber(value)
  return value == null || String(value).trim() === "" ? "—" : String(value)
}

export function OperationsFinanceReport({ view }: { view: View }) {
  const cfg = VIEWS[view]
  const { data, isLoading } = useSWR<{ rows: any[] }>(
    `/api/operations/finance-report?view=${view}`,
    fetcher,
    { refreshInterval: 30000 },
  )
  const rows = data?.rows ?? []

  return (
    <main className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Operations finance</p>
          <h1 className="text-3xl font-semibold tracking-tight">{cfg.title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{cfg.subtitle}</p>
        </div>
        <ExcelExportButton
          rows={rows}
          filename={`operations-${view}`}
          columns={cfg.columns.map((c) => ({ header: c.label, value: (r: any) => r[c.key] }))}
        />
      </div>

      <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <span>{cfg.source}</span>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cfg.summary(rows).map((k) => (
          <Card key={k.label}>
            <CardContent className="flex flex-col gap-1 pt-6">
              <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
              <span className="text-2xl font-semibold tracking-tight">{k.value}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <section className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              {cfg.columns.map((c) => (
                <TableHead key={c.key} className={c.align === "right" ? "text-right" : ""}>
                  {c.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={cfg.columns.length} className="p-8 text-center text-muted-foreground">
                  Loading report…
                </TableCell>
              </TableRow>
            )}
            {!isLoading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={cfg.columns.length} className="p-8 text-center text-muted-foreground">
                  No data yet. This report populates automatically as Finance bills/expenses, approved timesheets and project budgets are recorded.
                </TableCell>
              </TableRow>
            )}
            {rows.map((row, i) => {
              const isTotal = row.cost_category === "Total"
              return (
                <TableRow key={i} className={isTotal ? "bg-muted/40 font-medium" : ""}>
                  {cfg.columns.map((c) => (
                    <TableCell key={c.key} className={c.align === "right" ? "text-right tabular-nums" : ""}>
                      {renderCell(c, row)}
                    </TableCell>
                  ))}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </section>
    </main>
  )
}
