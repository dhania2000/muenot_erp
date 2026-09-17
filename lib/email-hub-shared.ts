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
  },
}
