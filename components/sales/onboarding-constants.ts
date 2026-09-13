// Client-safe onboarding vocabularies. These mirror the server-only
// constants in lib/sales/onboarding-service.ts (which cannot be imported into
// client components because it is marked "server-only").

export const ONBOARDING_STAGES = [
  "Planning",
  "Kickoff",
  "Setup",
  "Configuration",
  "Integration",
  "Training",
  "UAT",
  "Go-Live",
  "Handover",
  "Completed",
] as const

export const ONBOARDING_STATUSES = [
  "Not Started",
  "In Progress",
  "On Hold",
  "Blocked",
  "Completed",
  "Cancelled",
] as const

export const ONBOARDING_PRIORITIES = ["Low", "Medium", "High", "Urgent"] as const

export const ONBOARDING_HEALTH = ["Healthy", "At Risk", "Blocked"] as const

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline"

export const STATUS_VARIANT: Record<string, BadgeVariant> = {
  "Not Started": "outline",
  "In Progress": "secondary",
  Completed: "default",
  "On Hold": "outline",
  Blocked: "destructive",
  Cancelled: "destructive",
}

export const HEALTH_VARIANT: Record<string, BadgeVariant> = {
  Healthy: "default",
  "At Risk": "secondary",
  Blocked: "destructive",
}

export const PRIORITY_VARIANT: Record<string, BadgeVariant> = {
  Low: "outline",
  Medium: "secondary",
  High: "secondary",
  Urgent: "destructive",
}
