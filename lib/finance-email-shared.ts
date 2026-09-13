// Dependency-free finance email constants safe to import from client components.

export const FINANCE_EMAIL_CATEGORIES = [
  "General",
  "Invoice",
  "Payment Reminder",
  "Receipt",
  "Statement",
  "Purchase",
  "Vendor",
  "GST",
  "TDS",
  "Dunning",
  "Confidential",
] as const

export type FinanceEmailCategory = (typeof FINANCE_EMAIL_CATEGORIES)[number]

export const FINANCE_TEMPLATE_STATUSES = ["Draft", "Active", "Inactive", "Archived"] as const
export type FinanceTemplateStatus = (typeof FINANCE_TEMPLATE_STATUSES)[number]

export const FINANCE_TEMPLATE_AUDIENCES = [
  "Customer",
  "Vendor",
  "Internal",
  "Auditor",
  "Custom",
] as const
export type FinanceTemplateAudience = (typeof FINANCE_TEMPLATE_AUDIENCES)[number]

export type FinanceEmailTemplate = {
  id: number
  template_uid: string | null
  template_key: string | null
  name: string
  description: string | null
  category: string
  audience: string
  subject: string
  body: string
  body_text: string | null
  status: FinanceTemplateStatus
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
