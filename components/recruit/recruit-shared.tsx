"use client"

import Link from "next/link"
import { Star } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { APPLICATION_STAGES, OFFER_STATUSES, INTERVIEW_STATUSES, labelFor } from "@/lib/recruit"

export function PageHeader({
  title,
  description,
  icon: Icon,
  action,
}: {
  title: string
  description?: string
  icon?: React.ComponentType<{ className?: string }>
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        {Icon && (
          <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Icon className="size-5" />
          </div>
        )}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
          {description && <p className="text-sm text-muted-foreground text-pretty">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  )
}

export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Button variant="ghost" size="sm" render={<Link href={href} />}>
      {children}
    </Button>
  )
}

export function RatingStars({
  value,
  onChange,
  readOnly,
}: {
  value: number
  onChange?: (v: number) => void
  readOnly?: boolean
}) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={readOnly}
          onClick={() => onChange?.(n === value ? 0 : n)}
          className={cn("transition-colors", readOnly ? "cursor-default" : "cursor-pointer hover:scale-110")}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
        >
          <Star className={cn("size-4", n <= value ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40")} />
        </button>
      ))}
    </div>
  )
}

const STAGE_TONE = Object.fromEntries(APPLICATION_STAGES.map((s) => [s.key, s.tone]))

export function StageBadge({ stage }: { stage: string }) {
  const label = APPLICATION_STAGES.find((s) => s.key === stage)?.label ?? stage
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", STAGE_TONE[stage] ?? "border-border bg-muted text-muted-foreground")}>{label}</span>
}

const STATUS_TONE: Record<string, string> = {
  open: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  on_hold: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  closed: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  cancelled: "bg-muted text-muted-foreground border-border",
  scheduled: "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30",
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  no_show: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  draft: "bg-muted text-muted-foreground border-border",
  sent: "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30",
  accepted: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  rejected: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  expired: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
}

export function StatusPill({ status, kind }: { status: string; kind?: "job" | "offer" | "interview" }) {
  let label = status
  if (kind === "offer") label = labelFor(OFFER_STATUSES, status)
  else if (kind === "interview") label = labelFor(INTERVIEW_STATUSES, status)
  else label = status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ")
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", STATUS_TONE[status] ?? "border-border bg-muted text-muted-foreground")}>
      {label}
    </span>
  )
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">{message}</div>
  )
}
