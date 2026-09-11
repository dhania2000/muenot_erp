export function statusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "HR Approved":
      return "default"
    case "Manager Approved":
      return "secondary"
    case "Manager Rejected":
    case "HR Rejected":
      return "destructive"
    case "Cancelled":
      return "outline"
    default:
      return "secondary"
  }
}

export const LEAVE_STATUSES = [
  "Pending",
  "Manager Approved",
  "Manager Rejected",
  "HR Approved",
  "HR Rejected",
  "Cancelled",
] as const
