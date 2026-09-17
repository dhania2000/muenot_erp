// Dependency-free Operations email template constants + row type.
// Safe to import from client components (no server-only mysql2-backed imports).

export const OPERATIONS_EMAIL_CATEGORIES = [
  "General",
  "Project",
  "Task",
  "Milestone",
  "Deliverable",
  "Escalation",
  "Approval",
  "SLA",
  "Reminder",
  "Report",
] as const

export type OperationsEmailCategory = (typeof OPERATIONS_EMAIL_CATEGORIES)[number]

export const OPERATIONS_TEMPLATE_STATUSES = ["Draft", "Active", "Inactive", "Archived"] as const
export type OperationsTemplateStatus = (typeof OPERATIONS_TEMPLATE_STATUSES)[number]

export const OPERATIONS_TEMPLATE_AUDIENCES = [
  "Client",
  "Team",
  "Manager",
  "Vendor",
  "Internal",
  "Custom",
] as const
export type OperationsTemplateAudience = (typeof OPERATIONS_TEMPLATE_AUDIENCES)[number]

export type OperationsEmailTemplate = {
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
  status: OperationsTemplateStatus
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
