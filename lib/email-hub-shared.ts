// Dependency-free Email Hub constants + per-module UI config, safe to import
// from client components. The server-only service (lib/email-hub.ts) layers the
// data access, transport and automation catalog on top of these definitions.

export const EMAIL_HUB_STATUSES = [
  "Draft",
  "Scheduled",
  "Queued",
  "Sending",
  "Sent",
  "Failed",
  "Cancelled",
] as const

export type EmailHubStatus = (typeof EMAIL_HUB_STATUSES)[number]

export type EmailHubModuleKey = "operations" | "recruit"

export type EmailHubUiConfig = {
  key: EmailHubModuleKey
  /** Base path of the hub API, e.g. "/api/operations/email-hub". */
  apiBase: string
  /** Existing module template endpoint reused by the composer picker. */
  templatesUrl: string
  /** Where the Google connect flow returns to. */
  returnPath: string
  breadcrumb: string
  title: string
  description: string
  categories: string[]
  sensitiveCategories: string[]
  /** Label for the built-in recipient source (e.g. "Employees"). */
  recipientLabelPlural: string
  recipientNoun: string
  recipientSearchPlaceholder: string
  /** {{variable}} names offered in the personalization helper. */
  personalization: string[]
  /** Base path of the module template API, e.g. "/api/operations/email-templates". */
  templatesApiBase: string
  /** Copy + options for the Email Templates management page. */
  templateBreadcrumb: string
  templateTitle: string
  templateDescription: string
  templateAudiences: string[]
  templateDefaultAudience: string
}

// ---------------------------------------------------------------------------
// Email Hub template constants + row type (client-safe, dependency-free).
// Mirrors the HR template lifecycle so Operations & Recruitment templates get
// the same versioning, status governance and usage analytics.
// ---------------------------------------------------------------------------
export const EMAIL_HUB_TEMPLATE_STATUSES = ["Draft", "Active", "Inactive", "Archived"] as const
export type EmailHubTemplateStatus = (typeof EMAIL_HUB_TEMPLATE_STATUSES)[number]

export type EmailHubTemplate = {
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
  status: EmailHubTemplateStatus
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

export const EMAIL_HUB_UI: Record<EmailHubModuleKey, EmailHubUiConfig> = {
  operations: {
    key: "operations",
    apiBase: "/api/operations/email-hub",
    templatesUrl: "/api/operations/email-templates",
    returnPath: "/modules/operations/emails",
    breadcrumb: "Operations / Communication",
    title: "Operations Email Hub",
    description: "Compose, schedule and track every operations email from one place.",
    categories: [
      "General",
      "Project",
      "Client",
      "Task",
      "Deliverable",
      "Milestone",
      "Issue",
      "SLA",
      "Approval",
      "Escalation",
    ],
    sensitiveCategories: ["Escalation"],
    recipientLabelPlural: "Employees",
    recipientNoun: "employee",
    recipientSearchPlaceholder: "Search employees by name, ID, email or department",
    personalization: [
      "employee_name",
      "first_name",
      "employee_id",
      "department",
      "designation",
      "reporting_manager",
      "email",
    ],
    templatesApiBase: "/api/operations/email-templates",
    templateBreadcrumb: "Operations / Communication",
    templateTitle: "Operations Email Templates",
    templateDescription: "Manage reusable operations email templates.",
    templateAudiences: ["Employees", "Clients"],
    templateDefaultAudience: "Employees",
  },
  recruit: {
    key: "recruit",
    apiBase: "/api/recruit/email-hub",
    templatesUrl: "/api/recruit/email-templates",
    returnPath: "/modules/recruitment/emails",
    breadcrumb: "Recruitment / Communication",
    title: "Recruitment Email Hub",
    description: "Compose, schedule and track every candidate email from one place.",
    categories: [
      "General",
      "Application",
      "Screening",
      "Interview",
      "Assessment",
      "Offer",
      "Onboarding",
      "Rejection",
      "Follow-up",
    ],
    sensitiveCategories: ["Offer", "Rejection"],
    recipientLabelPlural: "Candidates",
    recipientNoun: "candidate",
    recipientSearchPlaceholder: "Search candidates by name, email or role applied",
    personalization: [
      "candidate_name",
      "first_name",
      "email",
      "job_applied",
      "application_id",
      "stage",
    ],
    templatesApiBase: "/api/recruit/email-templates",
    templateBreadcrumb: "Recruitment / Communication",
    templateTitle: "Recruitment Email Templates",
    templateDescription: "Manage reusable candidate email templates.",
    templateAudiences: ["Candidates"],
    templateDefaultAudience: "Candidates",
  },
}
