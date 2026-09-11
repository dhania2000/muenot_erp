import { Badge } from "@/components/ui/badge"

// Shared status/priority/SLA badge renderers so the list and detail views stay
// visually consistent. Colours are conveyed via semantic tokens + text so they
// never rely on colour alone (accessibility).

export function statusBadge(status: string) {
  const map: Record<string, string> = {
    Open: "bg-primary/10 text-primary border-primary/20",
    "In Progress": "bg-chart-2/15 text-foreground border-border",
    Waiting: "bg-muted text-muted-foreground border-border",
    Resolved: "bg-emerald-500/15 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
    Closed: "bg-muted text-muted-foreground border-border",
  }
  return <Badge variant="outline" className={map[status] || ""}>{status}</Badge>
}

export function priorityBadge(priority: string) {
  const map: Record<string, string> = {
    Low: "bg-muted text-muted-foreground border-border",
    Medium: "bg-primary/10 text-primary border-primary/20",
    High: "bg-amber-500/15 text-amber-600 border-amber-500/20 dark:text-amber-400",
    Urgent: "bg-destructive/15 text-destructive border-destructive/20",
  }
  return <Badge variant="outline" className={map[priority] || ""}>{priority}</Badge>
}

export function slaBadge(state?: string) {
  if (!state || state === "N/A") return null
  const map: Record<string, string> = {
    "On Track": "bg-emerald-500/15 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
    "Due Soon": "bg-amber-500/15 text-amber-600 border-amber-500/20 dark:text-amber-400",
    Breached: "bg-destructive/15 text-destructive border-destructive/20",
    Met: "bg-emerald-500/15 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
  }
  return <Badge variant="outline" className={map[state] || ""}>SLA: {state}</Badge>
}
