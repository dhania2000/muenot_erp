import { cn } from "@/lib/utils"

const STYLES: Record<string, string> = {
  Sent: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  Sending: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  Queued: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  Scheduled: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  Draft: "bg-muted text-muted-foreground border-border",
  Failed: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  Cancelled: "bg-muted text-muted-foreground border-border line-through",
}

export function EmailHubStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        STYLES[status] || "bg-muted text-muted-foreground border-border",
      )}
    >
      {status}
    </span>
  )
}
