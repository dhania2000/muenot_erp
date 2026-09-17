// Dependency-free Recruitment email template constants + row type.
// Safe to import from client components (no server-only mysql2-backed imports).

export const RECRUIT_EMAIL_CATEGORIES = [
  "General",
  "Sourcing",
  "Screening",
  "Interview",
  "Assessment",
  "Offer",
  "Onboarding",
  "Rejection",
  "Follow-up",
] as const

export type RecruitEmailCategory = (typeof RECRUIT_EMAIL_CATEGORIES)[number]

export const RECRUIT_TEMPLATE_STATUSES = ["Draft", "Active", "Inactive", "Archived"] as const
export type RecruitTemplateStatus = (typeof RECRUIT_TEMPLATE_STATUSES)[number]

export const RECRUIT_TEMPLATE_AUDIENCES = [
  "Candidate",
  "Recruiter",
  "Hiring Manager",
  "Interviewer",
  "HR",
  "Custom",
] as const
export type RecruitTemplateAudience = (typeof RECRUIT_TEMPLATE_AUDIENCES)[number]

export type RecruitEmailTemplate = {
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
  status: RecruitTemplateStatus
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
