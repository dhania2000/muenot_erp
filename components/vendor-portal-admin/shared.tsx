"use client"

import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ArrowDownRight, ArrowUpRight, Inbox, Search } from "lucide-react"

/* --------------------------------- KPIs --------------------------------- */

export type Tone = "default" | "warning" | "danger" | "success"

const TONE_ACCENT: Record<Tone, string> = {
  default: "text-foreground",
  warning: "text-amber-600 dark:text-amber-500",
  danger: "text-destructive",
  success: "text-emerald-600 dark:text-emerald-500",
}

const TONE_DOT: Record<Tone, string> = {
  default: "bg-muted-foreground/40",
  warning: "bg-amber-500",
  danger: "bg-destructive",
  success: "bg-emerald-500",
}

export function KpiCard({
  label,
  value,
  delta,
  tone = "default",
  icon,
}: {
  label: string
  value: number | string
  delta?: number
  tone?: Tone
  icon?: ReactNode
}) {
  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex items-start justify-between gap-3 p-4">
        <div className="grid gap-1">
          <div className="flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", TONE_DOT[tone])} aria-hidden />
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
          </div>
          <span className="text-2xl font-semibold tracking-tight tabular-nums">
            {typeof value === "number" ? value.toLocaleString() : value}
          </span>
          {typeof delta === "number" ? (
            <span
              className={cn(
                "flex items-center gap-0.5 text-xs font-medium",
                delta >= 0 ? "text-emerald-600 dark:text-emerald-500" : "text-destructive",
              )}
            >
              {delta >= 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
              {Math.abs(delta)}% vs last month
            </span>
          ) : null}
        </div>
        {icon ? <div className={cn("text-muted-foreground", TONE_ACCENT[tone])}>{icon}</div> : null}
      </CardContent>
    </Card>
  )
}

/* ----------------------------- Status badges ---------------------------- */

type BadgeVariant = "default" | "secondary" | "destructive" | "outline"

const STATUS_STYLES: Record<string, { variant: BadgeVariant; className?: string }> = {
  // portal
  active: { variant: "outline", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  verified: { variant: "outline", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  approved: { variant: "outline", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  complete: { variant: "outline", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  paid: { variant: "outline", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  completed: { variant: "outline", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  published: { variant: "outline", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  accepted: { variant: "outline", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },

  pending: { variant: "outline", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  "under-review": { variant: "outline", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  "needs-info": { variant: "outline", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  "in-progress": { variant: "outline", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  expiring: { variant: "outline", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  scheduled: { variant: "outline", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  "payment-scheduled": { variant: "outline", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  "change-requested": { variant: "outline", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  processing: { variant: "outline", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  flagged: { variant: "outline", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  "needs information": { variant: "outline", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },

  invited: { variant: "outline", className: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  sent: { variant: "outline", className: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  new: { variant: "outline", className: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  submitted: { variant: "outline", className: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  draft: { variant: "outline", className: "border-border bg-muted text-muted-foreground" },
  open: { variant: "outline", className: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  idle: { variant: "outline", className: "border-border bg-muted text-muted-foreground" },
  acknowledged: { variant: "outline", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  passed: { variant: "outline", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },

  suspended: { variant: "destructive" },
  rejected: { variant: "destructive" },
  disabled: { variant: "outline", className: "border-border bg-muted text-muted-foreground" },
  expired: { variant: "destructive" },
  failed: { variant: "destructive" },
  failure: { variant: "destructive" },
  locked: { variant: "destructive" },
  "not-started": { variant: "outline", className: "border-border bg-muted text-muted-foreground" },
  incomplete: { variant: "outline", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  unverified: { variant: "outline", className: "border-border bg-muted text-muted-foreground" },
  closed: { variant: "outline", className: "border-border bg-muted text-muted-foreground" },
  unpaid: { variant: "outline", className: "border-border bg-muted text-muted-foreground" },
  success: { variant: "outline", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const key = status.toLowerCase()
  const style = STATUS_STYLES[key] ?? { variant: "outline" as BadgeVariant }
  return (
    <Badge variant={style.variant} className={cn("capitalize", style.className)}>
      {label ?? status.replace(/-/g, " ")}
    </Badge>
  )
}

/* ----------------------------- Section frame ---------------------------- */

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
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border border-border bg-card", className)}>{children}</div>
}

/* ------------------------------- Toolbar -------------------------------- */

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

export function FilterChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string; count?: number }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
            value === o.key
              ? "border-primary/50 bg-primary/10 text-foreground"
              : "border-border bg-card text-muted-foreground hover:bg-muted/50",
          )}
        >
          {o.label}
          {typeof o.count === "number" ? (
            <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
              {o.count}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

/* ---------------------------- Empty / states ---------------------------- */

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-6 py-14 text-center">
      <div className="text-muted-foreground">{icon ?? <Inbox className="size-8" />}</div>
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-sm text-xs text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

export function TableSkeleton({ rows = 5, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="grid gap-2 p-3">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={cn("h-6", c === 0 ? "w-40" : "flex-1")} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  return (
    <EmptyState
      title="Couldn't load data"
      description="Something went wrong reaching the vendor portal service. Try again in a moment."
      action={
        onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    />
  )
}

/* ---------------------------- Misc utilities ---------------------------- */

export function fmtDate(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

export function fmtDateTime(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

export function fmtMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(amount)
  } catch {
    return `${currency} ${amount.toLocaleString()}`
  }
}

/* ------------------------------ Row actions ----------------------------- */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MoreHorizontal } from "lucide-react"
import { toast } from "sonner"

export type RowAction = {
  label: string
  onSelect?: () => void
  destructive?: boolean
  separatorBefore?: boolean
}

/** A compact "…" actions menu. Actions fall back to a toast so every control
 *  is wired to feedback the backend can replace later. */
export function RowActions({ label = "Actions", actions }: { label?: string; actions: RowAction[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="Row actions">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {actions.map((a, i) => (
          <div key={a.label}>
            {a.separatorBefore && i > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              onClick={() => (a.onSelect ? a.onSelect() : toast.success(`${a.label} — queued`))}
              className={cn(a.destructive && "text-destructive focus:text-destructive")}
            >
              {a.label}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* -------------------------------- Charts -------------------------------- */

export function BarList({
  data,
  max,
  valueFormat,
}: {
  data: { label: string; value: number }[]
  max?: number
  valueFormat?: (v: number) => string
}) {
  const top = max ?? Math.max(...data.map((d) => d.value), 1)
  return (
    <div className="grid gap-2.5">
      {data.map((d) => (
        <div key={d.label} className="grid gap-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{d.label}</span>
            <span className="font-medium tabular-nums">{valueFormat ? valueFormat(d.value) : d.value.toLocaleString()}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-foreground/70"
              style={{ width: `${Math.max(4, (d.value / top) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

export function Sparkbars({ data }: { data: { label: string; value: number }[] }) {
  const top = Math.max(...data.map((d) => d.value), 1)
  return (
    <div className="flex items-end gap-2" style={{ height: 120 }}>
      {data.map((d) => (
        <div key={d.label} className="flex flex-1 flex-col items-center gap-1.5">
          <div className="flex w-full flex-1 items-end">
            <div
              className="w-full rounded-t-sm bg-foreground/70 transition-all"
              style={{ height: `${Math.max(6, (d.value / top) * 100)}%` }}
              title={`${d.label}: ${d.value}`}
            />
          </div>
          <span className="text-[10px] text-muted-foreground">{d.label}</span>
        </div>
      ))}
    </div>
  )
}

export function DonutStat({ segments }: { segments: { name: string; value: number }[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1
  const shades = ["oklch(0.30 0 0)", "oklch(0.45 0 0)", "oklch(0.58 0 0)", "oklch(0.70 0 0)", "oklch(0.82 0 0)"]
  let acc = 0
  const stops = segments.map((s, i) => {
    const start = (acc / total) * 100
    acc += s.value
    const end = (acc / total) * 100
    return `${shades[i % shades.length]} ${start}% ${end}%`
  })
  return (
    <div className="flex items-center gap-5">
      <div
        className="size-28 shrink-0 rounded-full"
        style={{ background: `conic-gradient(${stops.join(", ")})` }}
        aria-hidden
      >
        <div className="flex size-full items-center justify-center">
          <div className="flex size-16 flex-col items-center justify-center rounded-full bg-card">
            <span className="text-base font-semibold tabular-nums">{total.toLocaleString()}</span>
            <span className="text-[10px] text-muted-foreground">Total</span>
          </div>
        </div>
      </div>
      <ul className="grid gap-1.5">
        {segments.map((s, i) => (
          <li key={s.name} className="flex items-center gap-2 text-xs">
            <span className="size-2.5 rounded-sm" style={{ background: shades[i % shades.length] }} aria-hidden />
            <span className="text-muted-foreground">{s.name}</span>
            <span className="font-medium tabular-nums">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
