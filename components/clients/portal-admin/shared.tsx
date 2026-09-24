"use client"

import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import { ArrowDownRight, ArrowUpRight, Search, type LucideIcon } from "lucide-react"

/* ---------------------------------------------------------------- Section shell */

export function SectionHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/* ---------------------------------------------------------------- KPI card */

const TONE_CLASS: Record<string, string> = {
  default: "text-foreground",
  positive: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-destructive",
}

export function KpiCard({
  label,
  value,
  delta,
  tone = "default",
}: {
  label: string
  value: number | string
  delta?: number
  tone?: "default" | "positive" | "warning" | "danger"
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="truncate text-xs text-muted-foreground" title={label}>
        {label}
      </div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <span className={cn("text-xl font-semibold tabular-nums", TONE_CLASS[tone])}>
          {typeof value === "number" ? value.toLocaleString() : value}
        </span>
        {typeof delta === "number" ? (
          <span
            className={cn(
              "flex items-center gap-0.5 text-xs font-medium",
              delta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
            )}
          >
            {delta >= 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
            {Math.abs(delta)}%
          </span>
        ) : null}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- Status badges */

type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral"

const TONE_BADGE: Record<BadgeTone, string> = {
  success: "border-transparent bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
  warning: "border-transparent bg-amber-500/12 text-amber-700 dark:text-amber-400",
  danger: "border-transparent bg-destructive/12 text-destructive",
  info: "border-transparent bg-sky-500/12 text-sky-700 dark:text-sky-400",
  neutral: "border-border text-muted-foreground",
}

export function StatusBadge({
  label,
  tone,
  className,
}: {
  label: string
  tone: BadgeTone
  className?: string
}) {
  return (
    <Badge variant="outline" className={cn(TONE_BADGE[tone], className)}>
      {label}
    </Badge>
  )
}

/* ---------------------------------------------------------------- Search input */

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-9"
        aria-label={placeholder}
      />
    </div>
  )
}

/* ---------------------------------------------------------------- Empty state */

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <Empty className="border border-dashed border-border bg-muted/10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}

/* ---------------------------------------------------------------- Charts (CSS/SVG) */

export function BarChart({
  data,
  className,
}: {
  data: { label: string; value: number }[]
  className?: string
}) {
  const max = Math.max(...data.map((d) => d.value), 1)
  return (
    <div className={cn("flex items-end gap-2", className)}>
      {data.map((d) => (
        <div key={d.label} className="flex flex-1 flex-col items-center gap-1.5">
          <div className="flex h-28 w-full items-end">
            <div
              className="w-full rounded-t bg-primary/80 transition-all"
              style={{ height: `${Math.max(6, (d.value / max) * 100)}%` }}
              title={`${d.label}: ${d.value.toLocaleString()}`}
            />
          </div>
          <span className="text-[10px] text-muted-foreground">{d.label}</span>
        </div>
      ))}
    </div>
  )
}

export function LineChart({
  data,
  className,
}: {
  data: { label: string; value: number }[]
  className?: string
}) {
  const w = 300
  const h = 96
  const pad = 6
  const max = Math.max(...data.map((d) => d.value), 1)
  const min = Math.min(...data.map((d) => d.value), 0)
  const range = max - min || 1
  const step = (w - pad * 2) / Math.max(1, data.length - 1)
  const points = data.map((d, i) => {
    const x = pad + i * step
    const y = h - pad - ((d.value - min) / range) * (h - pad * 2)
    return [x, y] as const
  })
  const line = points.map((p) => p.join(",")).join(" ")
  const area = `${pad},${h - pad} ${line} ${pad + (data.length - 1) * step},${h - pad}`
  return (
    <div className={className}>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-24 w-full" preserveAspectRatio="none" role="img" aria-label="Trend line">
        <polygon points={area} className="fill-primary/10" />
        <polyline points={line} className="fill-none stroke-primary" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => (
          <circle key={i} cx={p[0]} cy={p[1]} r={2.5} className="fill-primary" />
        ))}
      </svg>
      <div className="mt-1 flex justify-between px-1 text-[10px] text-muted-foreground">
        {data.map((d) => (
          <span key={d.label}>{d.label}</span>
        ))}
      </div>
    </div>
  )
}

export function FunnelChart({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(...data.map((d) => d.value), 1)
  return (
    <div className="grid gap-1.5">
      {data.map((d) => (
        <div key={d.label} className="grid grid-cols-[140px_1fr_auto] items-center gap-3 text-xs">
          <span className="truncate text-muted-foreground">{d.label}</span>
          <div className="h-4 overflow-hidden rounded bg-muted">
            <div className="h-full rounded bg-primary/80" style={{ width: `${(d.value / max) * 100}%` }} />
          </div>
          <span className="tabular-nums font-medium">{d.value}</span>
        </div>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------- Panel */

export function Panel({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("rounded-xl border border-border bg-card", className)}>
      {title ? (
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{title}</h3>
            {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className="p-4">{children}</div>
    </div>
  )
}

/* ---------------------------------------------------------------- badge tone helpers */

export function portalStatusTone(status: string): BadgeTone {
  switch (status) {
    case "active":
    case "accepted":
    case "approved":
    case "complete":
    case "verified":
    case "published":
    case "success":
      return "success"
    case "pending":
    case "invited":
    case "review":
    case "under_review":
    case "in_progress":
    case "documents_pending":
    case "in_review":
    case "needs_info":
    case "scheduled":
    case "idle":
    case "draft":
      return "warning"
    case "suspended":
    case "rejected":
    case "disabled":
    case "locked":
    case "expired":
    case "revoked":
    case "failed":
    case "denied":
      return "danger"
    case "new":
      return "info"
    default:
      return "neutral"
  }
}
