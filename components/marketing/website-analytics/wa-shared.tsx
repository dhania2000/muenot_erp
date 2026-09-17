"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return `${m}m ${rem.toString().padStart(2, "0")}s`
  const h = Math.floor(m / 60)
  return `${h}h ${(m % 60).toString().padStart(2, "0")}m`
}

export function formatCompact(n: number): string {
  const v = Number(n || 0)
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return String(v)
}

export function deltaLabel(current: number, previous: number | null | undefined): { text: string; positive: boolean } | null {
  if (previous == null) return null
  if (previous === 0) return current > 0 ? { text: "new", positive: true } : null
  const pct = ((current - previous) / previous) * 100
  const positive = pct >= 0
  return { text: `${positive ? "+" : ""}${pct.toFixed(1)}% vs prev`, positive }
}

/** A horizontal-bar breakdown list used across sources/devices/geo panels. */
export function BreakdownList({
  rows,
  labelKey,
  valueKey = "sessions",
  emptyText = "No data in this range yet.",
  formatValue,
}: {
  rows: Record<string, any>[]
  labelKey: string
  valueKey?: string
  emptyText?: string
  formatValue?: (n: number) => string
}) {
  if (!rows?.length) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
  }
  const max = Math.max(...rows.map((r) => Number(r[valueKey]) || 0), 1)
  return (
    <div className="flex flex-col gap-3">
      {rows.map((r, i) => {
        const value = Number(r[valueKey]) || 0
        const label = r[labelKey] == null || r[labelKey] === "" ? "Unknown" : String(r[labelKey])
        return (
          <div key={`${label}-${i}`} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="truncate pr-3">{label}</span>
              <span className="font-medium tabular-nums">{formatValue ? formatValue(value) : value.toLocaleString()}</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${(value / max) * 100}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function PanelCard({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}
