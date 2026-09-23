"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  Line,
  LineChart,
  Area,
  AreaChart,
  Pie,
  PieChart,
  Cell,
} from "recharts"
import { GripVertical, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { WidgetCatalogEntry, WidgetData, KpiTone } from "@/lib/dashboards/types"

const TONE_CLASS: Record<KpiTone, string> = {
  default: "text-foreground",
  positive: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  critical: "text-red-600 dark:text-red-400",
}

export function WidgetCard({
  entry,
  data,
  loading,
  editMode,
  onRemove,
  dragProps,
}: {
  entry: WidgetCatalogEntry
  data?: WidgetData
  loading?: boolean
  editMode?: boolean
  onRemove?: () => void
  dragProps?: React.HTMLAttributes<HTMLButtonElement> & { draggable?: boolean }
}) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <CardTitle className="text-sm font-semibold">{entry.title}</CardTitle>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{entry.module}</p>
        </div>
        {editMode ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Drag to reorder"
              className="cursor-grab rounded p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
              {...dragProps}
            >
              <GripVertical className="size-4" />
            </button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 text-muted-foreground"
              aria-label="Remove widget"
              onClick={onRemove}
            >
              <X className="size-4" />
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="flex-1">
        {loading || !data ? (
          <WidgetSkeleton type={entry.type} />
        ) : data.kind === "empty" ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{data.message}</p>
        ) : data.kind === "kpi" ? (
          <KpiBody data={data} />
        ) : data.kind === "chart" ? (
          <ChartBody data={data} />
        ) : (
          <TableBody_ data={data} />
        )}
      </CardContent>
    </Card>
  )
}

function WidgetSkeleton({ type }: { type: WidgetCatalogEntry["type"] }) {
  if (type === "kpi") {
    return (
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    )
  }
  return <Skeleton className="h-48 w-full" />
}

function KpiBody({ data }: { data: Extract<WidgetData, { kind: "kpi" }> }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {data.items.map((item, i) => (
        <div key={i} className="flex flex-col gap-1 rounded-lg border bg-muted/30 p-3">
          <span className="text-xs font-medium text-muted-foreground">{item.label}</span>
          <span className={cn("text-xl font-semibold tracking-tight", TONE_CLASS[item.tone ?? "default"])}>
            {item.value}
          </span>
          {item.hint ? <span className="text-[11px] text-muted-foreground">{item.hint}</span> : null}
        </div>
      ))}
    </div>
  )
}

function ChartBody({ data }: { data: Extract<WidgetData, { kind: "chart" }> }) {
  const config: ChartConfig = Object.fromEntries(
    data.series.map((s) => [s.key, { label: s.label, color: s.color }]),
  )

  if (!data.points.length) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No data</p>
  }

  if (data.chart === "pie") {
    const valueKey = data.series[0]?.key ?? "value"
    const pieConfig: ChartConfig = Object.fromEntries(
      data.points.map((p, i) => [
        String(p[data.xKey]),
        { label: String(p[data.xKey]), color: (p.fill as string) ?? `var(--chart-${(i % 5) + 1})` },
      ]),
    )
    return (
      <ChartContainer config={pieConfig} className="mx-auto aspect-square h-56">
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent nameKey={data.xKey} />} />
          <Pie data={data.points as any[]} dataKey={valueKey} nameKey={data.xKey} innerRadius={45} strokeWidth={2}>
            {data.points.map((p, i) => (
              <Cell key={i} fill={(p.fill as string) ?? `var(--chart-${(i % 5) + 1})`} />
            ))}
          </Pie>
          <ChartLegend content={<ChartLegendContent nameKey={data.xKey} />} className="flex-wrap" />
        </PieChart>
      </ChartContainer>
    )
  }

  if (data.chart === "line") {
    return (
      <ChartContainer config={config} className="aspect-auto h-56 w-full">
        <LineChart data={data.points as any[]} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey={data.xKey} tickLine={false} axisLine={false} tickMargin={8} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {data.series.map((s) => (
            <Line key={s.key} dataKey={s.key} type="monotone" stroke={s.color} strokeWidth={2} dot={false} />
          ))}
          {data.series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
        </LineChart>
      </ChartContainer>
    )
  }

  if (data.chart === "area") {
    return (
      <ChartContainer config={config} className="aspect-auto h-56 w-full">
        <AreaChart data={data.points as any[]} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey={data.xKey} tickLine={false} axisLine={false} tickMargin={8} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {data.series.map((s) => (
            <Area key={s.key} dataKey={s.key} type="monotone" stroke={s.color} fill={s.color} fillOpacity={0.2} />
          ))}
          {data.series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
        </AreaChart>
      </ChartContainer>
    )
  }

  // bar
  return (
    <ChartContainer config={config} className="aspect-auto h-56 w-full">
      <BarChart data={data.points as any[]} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey={data.xKey} tickLine={false} axisLine={false} tickMargin={8} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {data.series.map((s) => (
          <Bar key={s.key} dataKey={s.key} fill={s.color} radius={4} />
        ))}
        {data.series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
      </BarChart>
    </ChartContainer>
  )
}

function TableBody_({ data }: { data: Extract<WidgetData, { kind: "table" }> }) {
  if (!data.rows.length) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No records</p>
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {data.columns.map((c) => (
              <TableHead key={c.key} className={c.align === "right" ? "text-right" : undefined}>
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((row, i) => (
            <TableRow key={i}>
              {data.columns.map((c) => (
                <TableCell
                  key={c.key}
                  className={cn("whitespace-nowrap", c.align === "right" && "text-right tabular-nums")}
                >
                  {String(row[c.key] ?? "—")}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
