"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { AlertTriangle, Download, Gauge, Settings2, TrendingUp } from "lucide-react"

type UsageStatus = "ok" | "warning" | "over" | "no_limit"

type MeterUsage = {
  key: string
  label: string
  description: string
  unit: string
  kind: "counter" | "gauge"
  category: string
  decimals: number
  used: number
  previous: number
  limit: number | null
  limitPeriod: "month" | "day" | "none"
  hardLimit: boolean
  percent: number | null
  status: UsageStatus
}

type Overview = {
  periodStart: string
  periodEnd: string
  meters: MeterUsage[]
  trend: ({ date: string } & Record<string, number>)[]
  summary: {
    metersTracked: number
    metersWithLimit: number
    metersOverLimit: number
    metersWarning: number
  }
}

const CATEGORY_LABEL: Record<string, string> = {
  activity: "Activity",
  storage: "Storage",
  communication: "Communication",
  compute: "Compute",
  ai: "AI",
}

function fmt(value: number, decimals: number) {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function statusBadge(status: UsageStatus) {
  switch (status) {
    case "over":
      return <Badge variant="destructive">Over limit</Badge>
    case "warning":
      return (
        <Badge className="bg-amber-500 text-white hover:bg-amber-500/90">Near limit</Badge>
      )
    case "ok":
      return (
        <Badge variant="secondary" className="text-emerald-600 dark:text-emerald-400">
          Within limit
        </Badge>
      )
    default:
      return <Badge variant="outline">No limit</Badge>
  }
}

export function UsageMeteringConsole() {
  const { data, error, isLoading, mutate } = useSWR<Overview>("/api/billing/usage?trendDays=30", fetcher, {
    revalidateOnFocus: false,
  })

  const [editing, setEditing] = useState<MeterUsage | null>(null)
  const counterKeys = useMemo(
    () => data?.meters.filter((m) => m.kind === "counter").map((m) => m.key) ?? [],
    [data],
  )
  const [chartMeter, setChartMeter] = useState<string>("")

  const activeChartMeter = chartMeter || counterKeys[0] || ""
  const chartMeterDef = data?.meters.find((m) => m.key === activeChartMeter)

  const chartConfig = useMemo(
    () => ({
      value: {
        label: chartMeterDef?.label ?? "Usage",
        color: "hsl(var(--chart-1))",
      },
    }),
    [chartMeterDef],
  )

  const chartData = useMemo(() => {
    if (!data || !activeChartMeter) return []
    return data.trend.map((p) => ({
      date: p.date,
      value: Number(p[activeChartMeter] ?? 0),
    }))
  }, [data, activeChartMeter])

  async function handleExport() {
    const res = await fetch("/api/billing/usage/export")
    if (!res.ok) return
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `usage-${data?.periodStart ?? "report"}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  if (error) {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
          Failed to load usage data. Please try again.
        </div>
      </div>
    )
  }

  const summary = data?.summary

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Usage Metering</h1>
          <p className="text-sm text-muted-foreground">
            Track measurable resources per organisation and enforce quotas. Period{" "}
            {data ? `${data.periodStart} to ${data.periodEnd}` : "…"}.
          </p>
        </div>
        <Button onClick={handleExport} variant="outline" disabled={!data}>
          <Download className="mr-2 h-4 w-4" />
          Export usage
        </Button>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          icon={<Gauge className="h-4 w-4" />}
          label="Meters tracked"
          value={summary ? String(summary.metersTracked) : "—"}
        />
        <SummaryCard
          icon={<Settings2 className="h-4 w-4" />}
          label="Quotas configured"
          value={summary ? String(summary.metersWithLimit) : "—"}
        />
        <SummaryCard
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Near limit"
          value={summary ? String(summary.metersWarning) : "—"}
          tone={summary && summary.metersWarning > 0 ? "warning" : "default"}
        />
        <SummaryCard
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Over limit"
          value={summary ? String(summary.metersOverLimit) : "—"}
          tone={summary && summary.metersOverLimit > 0 ? "danger" : "default"}
        />
      </section>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4" />
              Daily usage trend
            </CardTitle>
            <CardDescription>Last 30 days of recorded events for the selected meter.</CardDescription>
          </div>
          <Select value={activeChartMeter} onValueChange={setChartMeter}>
            <SelectTrigger className="w-full sm:w-56">
              <SelectValue placeholder="Select meter" />
            </SelectTrigger>
            <SelectContent>
              {data?.meters
                .filter((m) => m.kind === "counter")
                .map((m) => (
                  <SelectItem key={m.key} value={m.key}>
                    {m.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {chartData.length > 0 ? (
            <ChartContainer config={chartConfig} className="h-[240px] w-full">
              <AreaChart data={chartData} margin={{ left: 4, right: 4, top: 8 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={24}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis tickLine={false} axisLine={false} width={40} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <defs>
                  <linearGradient id="fillUsage" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-value)" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="var(--color-value)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <Area
                  dataKey="value"
                  type="monotone"
                  stroke="var(--color-value)"
                  fill="url(#fillUsage)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartContainer>
          ) : (
            <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
              {isLoading ? "Loading…" : "No recorded usage yet for this meter."}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Meters</CardTitle>
          <CardDescription>
            Current-period usage for every measurable resource against its configured quota.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resource</TableHead>
                  <TableHead className="text-right">Usage</TableHead>
                  <TableHead className="text-right">Limit</TableHead>
                  <TableHead className="w-[180px]">Consumption</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Quota</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && !data ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                      Loading usage…
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.meters.map((m) => (
                    <TableRow key={m.key}>
                      <TableCell>
                        <div className="font-medium">{m.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {CATEGORY_LABEL[m.category] ?? m.category}
                          {" · "}
                          {m.kind === "gauge" ? "Live count" : "Metered"}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmt(m.used, m.decimals)}
                        <span className="ml-1 text-xs text-muted-foreground">{m.unit}</span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {m.limit != null ? fmt(m.limit, m.decimals) : "—"}
                      </TableCell>
                      <TableCell>
                        {m.percent != null ? (
                          <div className="space-y-1">
                            <Progress
                              value={Math.min(100, m.percent)}
                              className={
                                m.status === "over"
                                  ? "[&_[data-slot=progress-indicator]]:bg-destructive"
                                  : m.status === "warning"
                                    ? "[&_[data-slot=progress-indicator]]:bg-amber-500"
                                    : ""
                              }
                            />
                            <div className="text-right text-xs text-muted-foreground tabular-nums">
                              {m.percent.toFixed(0)}%
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>{statusBadge(m.status)}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(m)}>
                          <Settings2 className="mr-1 h-3.5 w-3.5" />
                          {m.limit != null ? "Edit" : "Set"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <LimitDialog
        meter={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          mutate()
        }}
      />
    </div>
  )
}

function SummaryCard({
  icon,
  label,
  value,
  tone = "default",
}: {
  icon: React.ReactNode
  label: string
  value: string
  tone?: "default" | "warning" | "danger"
}) {
  const toneClass =
    tone === "danger"
      ? "text-destructive"
      : tone === "warning"
        ? "text-amber-600 dark:text-amber-400"
        : "text-foreground"
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 p-4">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className={`text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
        </div>
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {icon}
        </div>
      </CardContent>
    </Card>
  )
}

function LimitDialog({
  meter,
  onClose,
  onSaved,
}: {
  meter: MeterUsage | null
  onClose: () => void
  onSaved: () => void
}) {
  const [limitValue, setLimitValue] = useState("")
  const [period, setPeriod] = useState<"month" | "day" | "none">("month")
  const [hardLimit, setHardLimit] = useState(false)
  const [saving, setSaving] = useState(false)
  const [lastKey, setLastKey] = useState<string | null>(null)

  // Sync local form state when a new meter is opened.
  if (meter && meter.key !== lastKey) {
    setLastKey(meter.key)
    setLimitValue(meter.limit != null ? String(meter.limit) : "")
    setPeriod(meter.limitPeriod === "none" ? "month" : meter.limitPeriod)
    setHardLimit(meter.hardLimit)
  }

  async function save() {
    if (!meter) return
    setSaving(true)
    try {
      await fetch("/api/billing/usage/limits", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meterKey: meter.key,
          limitValue: Number(limitValue || 0),
          period,
          hardLimit,
          isActive: true,
        }),
      })
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!meter) return
    setSaving(true)
    try {
      await fetch(`/api/billing/usage/limits?meterKey=${encodeURIComponent(meter.key)}`, {
        method: "DELETE",
      })
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={!!meter} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Quota — {meter?.label}</DialogTitle>
          <DialogDescription>
            Set a monthly or daily quota for this resource. Hard limits block further usage once
            reached; soft limits only warn.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="limit-value">Limit ({meter?.unit})</Label>
            <Input
              id="limit-value"
              type="number"
              min={0}
              value={limitValue}
              onChange={(e) => setLimitValue(e.target.value)}
              placeholder="e.g. 10000"
            />
          </div>
          <div className="space-y-2">
            <Label>Reset period</Label>
            <Select value={period} onValueChange={(v) => setPeriod(v as "month" | "day" | "none")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="month">Monthly</SelectItem>
                <SelectItem value="day">Daily</SelectItem>
                <SelectItem value="none">Total</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="hard-limit">Hard limit</Label>
              <p className="text-xs text-muted-foreground">Block usage once the quota is reached.</p>
            </div>
            <Switch id="hard-limit" checked={hardLimit} onCheckedChange={setHardLimit} />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {meter?.limit != null ? (
            <Button variant="ghost" className="text-destructive" onClick={remove} disabled={saving}>
              Remove quota
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save quota"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
