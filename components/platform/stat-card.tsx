import type { ComponentType } from "react"
import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"

/**
 * Compact KPI tile used across the platform console overview and section
 * headers. Purely presentational — every value passed in is derived from real
 * platform state by the caller.
 */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  accent,
}: {
  label: string
  value: string | number
  hint?: string
  icon?: ComponentType<{ className?: string }>
  accent?: "default" | "positive" | "warning" | "danger"
}) {
  const accentClass =
    accent === "positive"
      ? "text-emerald-600 dark:text-emerald-400"
      : accent === "warning"
        ? "text-amber-600 dark:text-amber-400"
        : accent === "danger"
          ? "text-destructive"
          : "text-foreground"

  return (
    <Card size="sm">
      <CardContent className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
          <span className={cn("text-2xl font-semibold tabular-nums leading-none", accentClass)}>{value}</span>
          {hint ? <span className="truncate text-xs text-muted-foreground">{hint}</span> : null}
        </div>
        {Icon ? (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Icon className="size-4.5" />
          </span>
        ) : null}
      </CardContent>
    </Card>
  )
}
