import { Badge } from "@/components/ui/badge"
import type { HrEmailStatus } from "@/lib/hr-email-shared"

const STYLES: Record<string, string> = {
  Sent: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  Failed: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300",
  Draft: "bg-muted text-muted-foreground",
  Scheduled: "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300",
  Queued: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  Sending: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  Cancelled: "bg-muted text-muted-foreground line-through",
}

export function HrEmailStatusBadge({ status }: { status: HrEmailStatus | string }) {
  return (
    <Badge variant="outline" className={`border-transparent ${STYLES[status] || "bg-muted"}`}>
      {status}
    </Badge>
  )
}
