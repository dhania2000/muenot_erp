import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// SPECS 56–66 — small presentational building blocks shared by the Security &
// Access screens so every page reads consistently.

/** Standard page heading used on every Security screen. */
export function SecurityHeading({
  title,
  spec,
  children,
}: {
  title: string
  spec: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{spec}</span>
      </div>
      <p className="max-w-3xl text-sm text-muted-foreground">{children}</p>
    </div>
  )
}

/** Empty-state block for tables/lists that have nothing to show yet. */
export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </span>
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="max-w-md text-sm text-muted-foreground">{children}</p>}
    </div>
  )
}

/** A read-only description of a configuration field the screen will manage. */
export function FieldSpec({
  label,
  hint,
  masked,
}: {
  label: string
  hint?: string
  masked?: boolean
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-card/50 p-3">
      <span className="flex items-center gap-1.5 text-sm font-medium">
        {label}
        {masked && (
          <span className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            masked
          </span>
        )}
      </span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

/** Grid wrapper for FieldSpec lists. */
export function FieldSpecGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid gap-2 sm:grid-cols-2 lg:grid-cols-3", className)}>{children}</div>
}
