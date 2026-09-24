"use client"

/**
 * Shared presentational primitives for the Vendor Portal admin console.
 * Keeps every section visually consistent (status tones, KPI tiles, section
 * headers, toolbars, empty states) so the many tables and cards read as one
 * coherent enterprise surface.
 */

import type { ReactNode } from "react"
import { Search, Inbox, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { STATUS_TONE, type Tone } from "./mock-data"

const TONE_CLASS: Record<Tone, string> = {
  success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  danger: "bg-destructive/10 text-destructive border-destructive/20",
  info: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  neutral: "bg-muted text-muted-foreground border-border",
  pending: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
}

const TONE_DOT: Record<Tone, string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-destructive",
  info: "bg-blue-500",
  neutral: "bg-muted-foreground/50",
  pending: "bg-amber-500",
}

export function StatusBadge({
  status,
  label,
  tone,
  className,
}: {
  status?: string
  label: string
  tone?: Tone
  className?: string
}) {
  const resolved: Tone = tone ?? (status ? STATUS_TONE[status] ?? "neutral" : "neutral")
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE_CLASS[resolved],
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", TONE_DOT[resolved])} />
      {label}
    </span>
  )
}

export function KpiTile({
  label,
  value,
  sub,
  delta,
  icon: Icon,
}: {
  label: string
  value: string | number
  sub?: string
  delta?: number
  icon?: LucideIcon
}) {
  return (
    <Card size="sm" className="gap-0">
      <CardContent className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          {Icon ? <Icon className="size-4 text-muted-foreground" /> : null}
        </div>
        <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
        <div className="flex items-center gap-1.5">
          {typeof delta === "number" ? (
            <span
              className={cn(
                "text-xs font-medium tabular-nums",
                delta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
              )}
            >
              {delta >= 0 ? "+" : ""}
              {delta}%
            </span>
          ) : null}
          {sub ? <span className="truncate text-xs text-muted-foreground">{sub}</span> : null}
        </div>
      </CardContent>
    </Card>
  )
}

export function SectionHeader({
  title,
  description,
  icon: Icon,
  actions,
}: {
  title: string
  description?: string
  icon?: LucideIcon
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-3">
        {Icon ? (
          <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-4.5" />
          </span>
        ) : null}
        <div className="grid gap-0.5">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

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
    <div className={cn("relative w-full sm:max-w-xs", className)}>
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

export function FilterChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; count?: number }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              active
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border bg-card text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {o.label}
            {typeof o.count === "number" ? (
              <span className={cn("tabular-nums", active ? "text-primary" : "text-muted-foreground/70")}>
                {o.count}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 px-6 py-14 text-center">
      <span className="inline-flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </span>
      <div className="grid gap-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? <p className="mx-auto max-w-sm text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  )
}

export function DataCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>{children}</div>
  )
}

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export type Column = { key: string; header: ReactNode; align?: "left" | "right"; className?: string }

export function AdminTable<T extends { id: string }>({
  columns,
  rows,
  render,
  onRowClick,
  empty,
}: {
  columns: Column[]
  rows: T[]
  render: (row: T, key: string) => ReactNode
  onRowClick?: (row: T) => void
  empty?: ReactNode
}) {
  if (rows.length === 0 && empty) return <>{empty}</>
  return (
    <DataCard>
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            {columns.map((c) => (
              <TableHead key={c.key} className={cn("px-3", c.align === "right" && "text-right", c.className)}>
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.id}
              className={onRowClick ? "cursor-pointer" : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((c) => (
                <TableCell key={c.key} className={cn("px-3 text-sm", c.align === "right" && "text-right", c.className)}>
                  {render(row, c.key)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataCard>
  )
}

/** A simple horizontal bar for charts we render without recharts. */
export function MiniBar({ value, max, tone = "info" }: { value: number; max: number; tone?: Tone }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full rounded-full", TONE_DOT[tone])} style={{ width: `${pct}%` }} />
    </div>
  )
}
