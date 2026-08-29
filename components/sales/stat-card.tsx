import { cn } from "@/lib/utils"

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
  icon: Icon,
}: {
  label: string
  value: string | number
  hint?: string
  tone?: "default" | "success" | "destructive" | "warning"
  icon?: any
}) {
  const toneText =
    tone === "success"
      ? "text-success"
      : tone === "destructive"
        ? "text-destructive"
        : tone === "warning"
          ? "text-warning-foreground"
          : "text-foreground"
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        {Icon ? <Icon className="size-4 text-muted-foreground/70" /> : null}
      </div>
      <div className={cn("mt-2 font-mono text-2xl font-semibold tabular-nums", toneText)}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  )
}
