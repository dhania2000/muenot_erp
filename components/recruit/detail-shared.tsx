import type React from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export function StatCard({
  label,
  value,
  icon: Icon,
  hint,
}: {
  label: string
  value: React.ReactNode
  icon?: React.ComponentType<{ className?: string }>
  hint?: string
}) {
  return (
    <Card className="border shadow-none">
      <CardContent className="flex items-center gap-3 p-4">
        {Icon && (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Icon className="size-4" />
          </div>
        )}
        <div className="min-w-0">
          <div className="text-xl font-semibold leading-none tabular-nums">{value}</div>
          <div className="mt-1 truncate text-xs text-muted-foreground">{label}</div>
          {hint && <div className="truncate text-[11px] text-muted-foreground/70">{hint}</div>}
        </div>
      </CardContent>
    </Card>
  )
}

export function Fact({
  label,
  value,
  className,
}: {
  label: string
  value: React.ReactNode
  className?: string
}) {
  const empty = value === null || value === undefined || value === "" || value === "—"
  return (
    <div className={className}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("text-sm font-medium", empty && "text-muted-foreground/60")}>
        {empty ? "—" : value}
      </div>
    </div>
  )
}

export function DetailSection({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

export function fmtDate(v: unknown): string {
  if (!v) return "—"
  const d = new Date(v as string)
  if (isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

export function fmtMoney(v: unknown, currency = "INR"): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return "—"
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currency || "INR",
      maximumFractionDigits: 0,
    }).format(n)
  } catch {
    return `${currency} ${n.toLocaleString("en-IN")}`
  }
}
