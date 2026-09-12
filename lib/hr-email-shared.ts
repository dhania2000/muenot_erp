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

// ---------------------------------------------------------------------------
// HR email template constants + row type.
// Kept here (dependency-free) so client components can import them without
// pulling in the server-only mysql2-backed lib/hr-email-templates module.
// ---------------------------------------------------------------------------
export const HR_TEMPLATE_STATUSES = ["Draft", "Active", "Inactive", "Archived"] as const
export type HrTemplateStatus = (typeof HR_TEMPLATE_STATUSES)[number]

export const HR_TEMPLATE_AUDIENCES = ["Employee", "Manager", "HR", "Candidate", "Custom"] as const
export type HrTemplateAudience = (typeof HR_TEMPLATE_AUDIENCES)[number]

export type HrEmailTemplate = {
  id: number
  template_uid: string | null
  template_key: string | null
  name: string
  description: string | null
  category: string
  audience: string
  event_key: string | null
  subject: string
  body: string
  body_text: string | null
  status: HrTemplateStatus
  version: number
  usage_count: number
  last_used_at: string | null
  attachment_pathname: string | null
  attachment_name: string | null
  attachment_type: string | null
  attachment_size: number | null
  created_by: number | null
  updated_by: number | null
  created_at: string | null
  updated_at: string | null
}
