export type ShiftChangeStatus = "Pending" | "Approved" | "Rejected" | "Cancelled" | "Withdrawn"

export const SHIFT_CHANGE_STATUSES: ShiftChangeStatus[] = [
  "Pending",
  "Approved",
  "Rejected",
  "Cancelled",
  "Withdrawn",
]

export function statusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "Approved":
      return "default"
    case "Pending":
      return "secondary"
    case "Rejected":
      return "destructive"
    case "Cancelled":
    case "Withdrawn":
      return "outline"
    default:
      return "secondary"
  }
}

/** Human summary of a change window. */
export function formatWindow(changeType: string, from: string | null, to: string | null): string {
  const f = from ? String(from).slice(0, 10) : "—"
  if (changeType === "Temporary") return `${f} → ${to ? String(to).slice(0, 10) : "—"}`
  return `${f} onward`
}

/** Short "07:00–15:00" style label with an overnight marker. */
export function shiftTimeLabel(start?: string | null, end?: string | null, overnight?: boolean): string {
  if (!start || !end) return "—"
  const s = String(start).slice(0, 5)
  const e = String(end).slice(0, 5)
  return `${s}–${e}${overnight ? " (+1)" : ""}`
}
