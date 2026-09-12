// Dependency-free HR email constants safe to import from client components.

export const HR_EMAIL_CATEGORIES = [
  "General",
  "Onboarding",
  "Leave",
  "Attendance",
  "Payroll",
  "Promotion",
  "Appreciation",
  "Warning",
  "Offboarding",
  "Policy",
  "Confidential",
] as const

export type HrEmailCategory = (typeof HR_EMAIL_CATEGORIES)[number]

/** Categories that carry sensitive content and require an extra permission. */
export const SENSITIVE_HR_EMAIL_CATEGORIES = new Set<string>(["Warning", "Confidential"])

export type HrEmailStatus =
  | "Draft"
  | "Scheduled"
  | "Queued"
  | "Sending"
  | "Sent"
  | "Failed"
  | "Cancelled"

export const HR_EMAIL_STATUSES: HrEmailStatus[] = [
  "Draft",
  "Scheduled",
  "Queued",
  "Sending",
  "Sent",
  "Failed",
  "Cancelled",
]
