// Dependency-free Sales email constants, safe to import from client components.

export const SALES_EMAIL_CATEGORIES = [
  "General",
  "Introduction",
  "Follow Up",
  "Proposal",
  "Quotation",
  "Onboarding",
  "Reminder",
  "Thank You",
  "Nurture",
] as const

export type SalesEmailCategory = (typeof SALES_EMAIL_CATEGORIES)[number]

export type SalesEmailStatus =
  | "Draft"
  | "Scheduled"
  | "Queued"
  | "Sending"
  | "Sent"
  | "Opened"
  | "Failed"
  | "Cancelled"

export const SALES_EMAIL_STATUSES: SalesEmailStatus[] = [
  "Draft",
  "Scheduled",
  "Queued",
  "Sending",
  "Sent",
  "Opened",
  "Failed",
  "Cancelled",
]
