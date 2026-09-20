import type { NavItem, NavChild } from "@/components/app-shell"
import { getUserAccessibleModules, getFeatureChecker } from "@/lib/permissions"
import type { SessionPayload } from "@/lib/auth"
import {
  Users2,
  TrendingUp,
  Wallet,
  UserPlus,
  Settings2,
  ShieldCheck,
  BriefcaseBusiness,
  TicketCheck,
  Package,
  Scale,
  ExternalLink,
  Megaphone,
  MessageCircle,
  LayoutDashboard,
  CreditCard,
  HardDrive,
  ClipboardList,
  Workflow,
} from "lucide-react"
import { MANAGEMENT_ENTITIES } from "@/lib/management-entities"

function settingEnabled(v: string | undefined, fallback = true) {
  if (v == null) return fallback
  const t = v.trim().toLowerCase()
  return t === "enabled" || t === "true" || t === "1" || t === "yes"
}

const moduleIcons: Record<string, NavItem["icon"]> = {
  hr: <Users2 className="size-4" />,
  sales: <TrendingUp className="size-4" />,
  finance: <Wallet className="size-4" />,
  recruitment: <UserPlus className="size-4" />,
  operations: <Settings2 className="size-4" />,
  clients: <BriefcaseBusiness className="size-4" />,
  tickets: <TicketCheck className="size-4" />,
  products: <Package className="size-4" />,
  legal: <Scale className="size-4" />,
  marketing: <Megaphone className="size-4" />,
}

type FeatureChild = { label: string; href?: string; feature?: string; children?: FeatureChild[] }

// Marketing sub-pages shown in the sidebar dropdown. The Marketing module is
// not stored in the `modules` table, so it is injected into the sidebar
// directly below, but each child is gated by a permission-matrix feature slug
// (resolved onto the Marketing permission modules) just like every other module.
const MARKETING_CHILDREN: FeatureChild[] = [
  { label: "Dashboard", href: "/modules/marketing/dashboard", feature: "marketing.view_dashboard" },
  { label: "Contacts", href: "/modules/marketing/contacts", feature: "marketing.view_contacts" },
  { label: "Lead Generation", href: "/modules/marketing/lead-generation", feature: "marketing.view_lead_generation" },
  { label: "Journeys", href: "/modules/marketing/journeys", feature: "marketing.view_journeys" },
  { label: "Marketing Planner", href: "/modules/marketing/planner", feature: "marketing.view_planner" },
  {
    label: "Marketing Campaigns",
    children: [
      { label: "Overview", href: "/modules/marketing/campaigns", feature: "marketing.view_campaigns" },
      { label: "Email", href: "/modules/marketing/campaigns/email", feature: "marketing.view_campaigns" },
      { label: "Social", href: "/modules/marketing/campaigns/social", feature: "marketing.view_campaigns" },
    ],
  },
  { label: "Website Analytics", href: "/modules/marketing/website-analytics", feature: "marketing.view_website_analytics" },
  { label: "Library", href: "/modules/marketing/library", feature: "marketing.view_library" },
]

// Sales sub-pages shown in the sidebar dropdown, each gated by a feature slug.
const HR_CHILDREN: FeatureChild[] = [
  { label: "HR Dashboard", href: "/modules/hr/dashboard", feature: "hr.view_dashboard" },
  { label: "Employees", href: "/modules/hr/employees", feature: "hr.view_employees" },
  { label: "Employee Documents", href: "/modules/hr/employee-documents", feature: "hr.view_documents" },
  { label: "Attendance", href: "/modules/hr/attendance", feature: "hr.view_attendance" },
  { label: "Attendance Regularisation", href: "/modules/hr/attendance-regularisation", feature: "hr.view_regularisation" },
  { label: "Screen Activity Monitoring", href: "/modules/hr/screen-monitoring", feature: "hr.view_screen_monitoring" },
  { label: "HR Support", href: "/modules/hr/support", feature: "hr.view_support" },
  { label: "Offboarding", href: "/modules/hr/offboarding", feature: "hr.view_offboarding" },
  {
    label: "Leaves",
    children: [
      { label: "Leave Requests", href: "/modules/hr/leave-requests", feature: "hr.view_leave_requests" },
      { label: "Leave Balances", href: "/modules/hr/leave-balances", feature: "hr.view_leave_balances" },
      { label: "Leave Quota History", href: "/modules/hr/leave-quota-history", feature: "hr.view_leave_quota_history" },
      { label: "Leave Types", href: "/modules/hr/leave-types", feature: "hr.view_leave_types" },
    ],
  },
  {
    label: "Shifts",
    children: [
      { label: "Shifts", href: "/modules/hr/shifts", feature: "hr.view_shifts" },
      { label: "Shift Change Requests", href: "/modules/hr/shift-change-requests", feature: "hr.view_shift_change_requests" },
      { label: "Shift Assignments", href: "/modules/hr/shift-workflows?kind=assignments", feature: "hr.view_shift_assignments" },
      { label: "Shift Rotations", href: "/modules/hr/shift-rotations", feature: "hr.view_shift_rotations" },
      { label: "Rotation Sequences", href: "/modules/hr/shift-workflows?kind=sequences", feature: "hr.view_rotation_sequences" },
      { label: "Rotation Employees", href: "/modules/hr/shift-workflows?kind=employees", feature: "hr.view_rotation_employees" },
    ],
  },
  { label: "HR Master Data", href: "/modules/hr/master-data", feature: "hr.view_master_data" },
  { label: "HR Emails", href: "/modules/hr/emails", feature: "hr.view_emails" },
  { label: "HR Email Templates", href: "/modules/hr/email-templates", feature: "hr.view_email_templates" },
  { label: "Letter Templates", href: "/modules/hr/letter-templates", feature: "hr.view_letter_templates" },
  { label: "Letters", href: "/modules/hr/letters", feature: "hr.view_letters" },
  { label: "Generate Letter", href: "/modules/hr/letters/generate", feature: "hr.view_letters" },
]

const FINANCE_CHILDREN: { label: string; href: string; feature: string }[] = [
  { label: "Dashboard", href: "/modules/finance", feature: "finance.view_dashboard" },
  { label: "Sales Invoices", href: "/modules/finance/sales-invoices", feature: "finance.view_sales_invoices" },
  { label: "Purchase Bills", href: "/modules/finance/purchase-bills", feature: "finance.view_purchase_bills" },
  { label: "Expenses", href: "/modules/finance/expenses", feature: "finance.view_expenses" },
  { label: "FTE Invoices", href: "/modules/finance/fte-invoices", feature: "finance.view_fte_invoices" },
  { label: "Freelance Invoices", href: "/modules/finance/freelance-invoices", feature: "finance.view_freelance_invoices" },
  { label: "Vendors", href: "/modules/finance/customers-vendors", feature: "finance.view_customers_vendors" },
  { label: "Bank Transactions", href: "/modules/finance/bank-transactions", feature: "finance.view_bank_transactions" },
  { label: "Bank & Cash", href: "/modules/finance/bank-cash", feature: "finance.view_bank_cash" },
  { label: "Chart of Accounts", href: "/modules/finance/chart-of-accounts", feature: "finance.view_chart_of_accounts" },
  { label: "Fixed Assets", href: "/modules/finance/fixed-assets", feature: "finance.view_fixed_assets" },
  { label: "Loans & Advances", href: "/modules/finance/loans-advances", feature: "finance.view_loans_advances" },
  { label: "Investments", href: "/modules/finance/investments", feature: "finance.view_investments" },
  { label: "Provisions & Accruals", href: "/modules/finance/provisions-accruals", feature: "finance.view_provisions_accruals" },
  { label: "Capital & Equity", href: "/modules/finance/capital-equity", feature: "finance.view_capital_equity" },
  { label: "Related Parties", href: "/modules/finance/related-parties", feature: "finance.view_related_parties" },
  { label: "Legal Entities", href: "/modules/finance/legal-entities", feature: "finance.entities" },
  { label: "GST Filing", href: "/modules/finance/gst-filing", feature: "finance.gst_filing" },
  { label: "TDS Filing", href: "/modules/finance/tds-filing", feature: "finance.tds_filing" },
  { label: "Journal Entries", href: "/modules/finance/journal-entries", feature: "finance.journal_entries" },
  { label: "General Ledger", href: "/modules/finance/general-ledger", feature: "finance.general_ledger" },
  { label: "Financial Reports", href: "/modules/finance/financial-reports", feature: "finance.financial_reports" },
  { label: "Emails", href: "/modules/finance/emails", feature: "finance.send_emails" },
  { label: "Email Templates", href: "/modules/finance/email-templates", feature: "finance.view_email_templates" },
]

// Recruitment sidebar organised as a hierarchical ERP structure. Parent groups
// are collapsible; every leaf keeps its original route and permission slug so
// existing pages, URLs and permissions are preserved. "Candidate Master" is
// intentionally omitted — Candidate Database is the single candidate registry
// and Candidate 360 opens the unified profile from it.
const RECRUITMENT_CHILDREN: FeatureChild[] = [
  {
    label: "Dashboard",
    children: [
      { label: "Recruit Dashboard", href: "/modules/recruitment", feature: "recruitment.view_dashboard" },
    ],
  },
  {
    label: "Hiring",
    children: [
      { label: "Requisition Hiring", href: "/modules/recruitment/requisition-hiring", feature: "recruitment.requisitions" },
      { label: "Job Requisitions", href: "/modules/recruitment/job-requisitions", feature: "recruitment.requisitions" },
      { label: "Jobs", href: "/modules/recruitment/jobs", feature: "recruitment.view_jobs" },
      { label: "Job Skills", href: "/modules/recruitment/job-skills", feature: "recruitment.view_skills" },
      { label: "Recruitment Sources", href: "/modules/recruitment/recruitment-sources", feature: "recruitment.candidates" },
      { label: "Recruitment Campaigns", href: "/modules/recruitment/recruitment-campaigns", feature: "recruitment.requisitions" },
    ],
  },
  {
    label: "Candidates",
    children: [
      { label: "Candidate Database", href: "/modules/recruitment/candidate-database", feature: "recruitment.view_candidates" },
      { label: "Job Applications", href: "/modules/recruitment/job-applications", feature: "recruitment.view_applications" },
      { label: "Screening", href: "/modules/recruitment/screening", feature: "recruitment.candidates" },
      { label: "Talent Pool", href: "/modules/recruitment/talent-pool", feature: "recruitment.candidates" },
      { label: "Candidate Activities", href: "/modules/recruitment/candidate-activities", feature: "recruitment.candidates" },
      { label: "Candidate Documents", href: "/modules/recruitment/candidate-documents", feature: "recruitment.candidates" },
      { label: "Employee Referrals", href: "/modules/recruitment/employee-referrals", feature: "recruitment.candidates" },
      { label: "Candidate 360", href: "/modules/recruitment/candidate-360", feature: "recruitment.view_candidates" },
    ],
  },
  {
    label: "Interviews",
    children: [
      { label: "Interview Schedule", href: "/modules/recruitment/interview-schedule", feature: "recruitment.schedule_interviews" },
      { label: "Interview Tracker", href: "/modules/recruitment/interview-tracker", feature: "recruitment.interviews" },
      { label: "Interview Feedback", href: "/modules/recruitment/interview-feedback", feature: "recruitment.interviews" },
      { label: "Assessment Tracker", href: "/modules/recruitment/assessment-tracker", feature: "recruitment.interviews" },
    ],
  },
  {
    label: "Selection & Onboarding",
    children: [
      { label: "Selection & Offers", href: "/modules/recruitment/selection-offers", feature: "recruitment.offers" },
      { label: "Job Offer Letter", href: "/modules/recruitment/job-offer-letter", feature: "recruitment.manage_offers" },
      { label: "Background Verification", href: "/modules/recruitment/background-verification", feature: "recruitment.candidates" },
      { label: "Reference Check", href: "/modules/recruitment/reference-check", feature: "recruitment.candidates" },
      { label: "Pre-Joining", href: "/modules/recruitment/pre-joining", feature: "recruitment.offers" },
      { label: "Onboarding", href: "/modules/recruitment/onboarding", feature: "recruitment.manage_offers" },
    ],
  },
  {
    label: "Recruitment Operations",
    children: [
      { label: "Recruitment Tasks", href: "/modules/recruitment/recruitment-tasks", feature: "recruitment.candidates" },
      { label: "Recruitment Follow-ups", href: "/modules/recruitment/recruitment-followups", feature: "recruitment.candidates" },
      { label: "Recruitment Vendors", href: "/modules/recruitment/recruitment-vendors", feature: "recruitment.requisitions" },
      { label: "Recruitment Costs", href: "/modules/recruitment/recruitment-costs", feature: "recruitment.requisitions" },
    ],
  },
  {
    label: "Communication",
    children: [
      { label: "Email", href: "/modules/recruitment/emails", feature: "recruitment.view_emails" },
      { label: "Email Templates", href: "/modules/recruitment/email-templates", feature: "recruitment.view_email_templates" },
    ],
  },
  {
    label: "Reports & Settings",
    children: [
      { label: "Recruit Report", href: "/modules/recruitment/recruit-job-report", feature: "recruitment.view_reports" },
      { label: "Recruitment Settings", href: "/modules/recruitment/recruitment-settings", feature: "recruitment.requisitions" },
      { label: "Career Site", href: "/modules/recruitment/career-site", feature: "recruitment.view_jobs" },
    ],
  },
]

// Operations sidebar organised as a hierarchical ERP structure. Parent groups
// are collapsible; every existing leaf keeps its original route + permission
// slug so current pages, URLs and permissions keep working. New sub-modules
// slot into their group and are gated by their own operations.view_* feature.
const OPERATIONS_CHILDREN: FeatureChild[] = [
  {
    label: "Dashboard",
    children: [
      { label: "Operations Dashboard", href: "/modules/operations", feature: "operations.view_dashboard" },
    ],
  },
  {
    label: "Projects",
    children: [
      { label: "Project Management", href: "/modules/operations/projects", feature: "operations.view_projects" },
      { label: "Project Milestones", href: "/modules/operations/milestones", feature: "operations.view_milestones" },
      { label: "Project Deliverables", href: "/modules/operations/deliverables", feature: "operations.view_deliverables" },
      { label: "Project Documents", href: "/modules/operations/project-documents", feature: "operations.view_project_documents" },
    ],
  },
  {
    label: "Work Management",
    children: [
      { label: "Tasks", href: "/modules/operations/tasks", feature: "operations.view_tasks" },
      { label: "Task Board", href: "/modules/operations/task-board", feature: "operations.view_tasks" },
      { label: "Work Orders", href: "/modules/operations/work-orders", feature: "operations.view_work_orders" },
      { label: "Meetings", href: "/modules/operations/meetings", feature: "operations.view_meetings" },
    ],
  },
  {
    label: "Resources",
    children: [
      { label: "Resources", href: "/modules/operations/resources", feature: "operations.view_resources" },
      { label: "Resource Requests", href: "/modules/operations/resource-requests", feature: "operations.view_resource_requests" },
      { label: "Allocations", href: "/modules/operations/allocations", feature: "operations.view_allocations" },
      { label: "Skill Matrix", href: "/modules/operations/skill-matrix", feature: "operations.view_skill_matrix" },
      { label: "Capacity Planning", href: "/modules/operations/capacity-planning", feature: "operations.view_capacity_planning" },
      { label: "Utilization", href: "/modules/operations/utilization", feature: "operations.view_utilization" },
      { label: "Resource Conflict", href: "/modules/operations/resource-conflict", feature: "operations.view_allocations" },
    ],
  },
  {
    label: "Timesheets",
    children: [
      { label: "Timesheet Management", href: "/modules/operations/timesheets", feature: "operations.view_timesheets" },
      { label: "Productivity", href: "/modules/operations/productivity", feature: "operations.view_productivity" },
    ],
  },
  {
    label: "Quality & SLA",
    children: [
      { label: "Quality Reviews", href: "/modules/operations/quality", feature: "operations.view_quality" },
      { label: "QA Audits", href: "/modules/operations/qa-audits", feature: "operations.view_qa_audits" },
      { label: "SLA Monitoring", href: "/modules/operations/sla-monitoring", feature: "operations.view_sla_monitoring" },
      { label: "Quality Scorecards", href: "/modules/operations/scorecards", feature: "operations.view_scorecards" },
      { label: "Scorecard Criteria", href: "/modules/operations/scorecard-criteria", feature: "operations.view_scorecard_criteria" },
      { label: "Corrective Actions", href: "/modules/operations/corrective-actions", feature: "operations.view_corrective_actions" },
    ],
  },
  {
    label: "Issues",
    children: [
      { label: "Issue Register", href: "/modules/operations/issues", feature: "operations.view_issues" },
      { label: "Escalations", href: "/modules/operations/escalations", feature: "operations.view_escalations" },
      { label: "Root Cause / CAPA", href: "/modules/operations/root-cause-capa", feature: "operations.view_root_cause_capa" },
    ],
  },
  {
    label: "Process Management",
    children: [
      { label: "SOPs", href: "/modules/operations/sops", feature: "operations.view_sops" },
      { label: "Checklists", href: "/modules/operations/checklists", feature: "operations.view_checklists" },
      { label: "Approvals", href: "/modules/operations/approvals", feature: "operations.view_approvals" },
    ],
  },
  {
    label: "Client Operations",
    children: [
      { label: "Client Requirements", href: "/modules/operations/client-requirements", feature: "operations.view_client_requirements" },
      { label: "Client Deliverables", href: "/modules/operations/client-deliverables", feature: "operations.view_client_deliverables" },
      { label: "Client Approvals", href: "/modules/operations/client-approvals", feature: "operations.view_client_approvals" },
    ],
  },
  {
    label: "Finance",
    children: [
      { label: "Project Cost", href: "/modules/operations/project-cost", feature: "operations.view_project_cost" },
      { label: "Resource Cost", href: "/modules/operations/resource-cost", feature: "operations.view_resource_cost" },
      { label: "Vendor Cost", href: "/modules/operations/vendor-cost", feature: "operations.view_vendor_cost" },
      { label: "Budget vs Actual", href: "/modules/operations/budget-vs-actual", feature: "operations.view_budget_vs_actual" },
    ],
  },
  {
    label: "Communication",
    children: [
      { label: "Emails", href: "/modules/operations/emails", feature: "operations.send_emails" },
      { label: "Email Templates", href: "/modules/operations/email-templates", feature: "operations.view_email_templates" },
    ],
  },
]

const CLIENTS_CHILDREN = [
  { label: "Clients", href: "/modules/clients/clients", feature: "clients.view_clients" },
]

const TICKETS_CHILDREN = [
  { label: "All Tickets", href: "/modules/tickets/all", feature: "tickets.view_tickets" },
]

const PRODUCTS_CHILDREN = [
  { label: "Product Catalog", href: "/modules/products/catalog", feature: "products.view_products" },
]

const LEGAL_CHILDREN = [
  { label: "Contracts", href: "/modules/legal/contracts", feature: "legal.view_contracts" },
  { label: "Templates", href: "/modules/legal/templates", feature: "legal.view_contract_templates" },
  { label: "Esign", href: "/modules/legal/esign", feature: "legal.view_esign" },
]

const ASSETS_CHILDREN = [
  { label: "Employee Assets", href: "/modules/assets/employee-assets" },
  { label: "Company Subscriptions", href: "/modules/assets/company-subscriptions" },
]

const SALES_CHILDREN: { label: string; href: string; feature: string }[] = [
  { label: "Dashboard", href: "/modules/sales/dashboard", feature: "sales.view_dashboard" },
  { label: "Leads", href: "/modules/sales/leads", feature: "sales.view_leads" },
  { label: "Follow-ups", href: "/modules/sales/followups", feature: "sales.view_leads" },
  { label: "Companies", href: "/modules/sales/companies", feature: "sales.view_companies" },
  { label: "Meetings", href: "/modules/sales/meetings", feature: "sales.view_meetings" },
  { label: "Quotations", href: "/modules/sales/quotations", feature: "sales.view_quotations" },
  { label: "Contracts", href: "/modules/sales/contracts", feature: "sales.view_contracts" },
  { label: "Email Templates", href: "/modules/sales/email-templates", feature: "sales.view_email_templates" },
  { label: "Emails", href: "/modules/sales/emails", feature: "sales.send_emails" },
  { label: "Onboarding", href: "/modules/sales/onboarding", feature: "sales.manage_onboarding" },
  { label: "Forecast", href: "/modules/sales/forecast", feature: "sales.view_dashboard" },
  { label: "Get Email Name", href: "/modules/sales/get-email-name", feature: "sales.get_email_name" },
]

// Every Administration sub-module. This is the single source of truth for the
// Administration section so the workspace sidebar and the /admin routes expose
// exactly the same set of links — navigating into any admin page keeps the same
// sidebar instead of swapping to a different shell.
export const ADMINISTRATION_CHILDREN: NavChild[] = [
  { label: "User lifecycle", href: "/admin/users" },
  { label: "Roles & permissions", href: "/admin/roles" },
  { label: "Data permissions", href: "/admin/data-permissions" },
  { label: "Approval authority", href: "/admin/approval-authority" },
  { label: "Maker-checker", href: "/admin/maker-checker" },
  { label: "Segregation of duties", href: "/admin/sod" },
  // SPEC 6 — Organization hierarchy management (org → entity → BU → … → team).
  { label: "Organization hierarchy", href: "/modules/organization" },
  // SPEC 7 — Multi-entity: the legal-entity registry (separate tax/bank/books).
  { label: "Legal entities", href: "/modules/finance/legal-entities" },
  { label: "Employee Links", href: "/admin/employee-links" },
  { label: "Settings", href: "/admin/settings" },
]

// SPECS 46–50 — The Automation Center groups the existing workflow engine with
// the event, notification and email monitoring surfaces under one admin area so
// automation is not scattered. Every entry is an existing, real-data-backed
// admin page; nothing here creates a second engine.
export const AUTOMATION_CHILDREN: NavChild[] = [
  { label: "Overview", href: "/admin/automation" },
  { label: "Workflows", href: "/admin/workflows" },
  { label: "Events", href: "/admin/automation/events" },
  { label: "Notifications", href: "/admin/automation/notifications" },
  { label: "Email", href: "/admin/automation/email" },
]

// SPECS 56–66 — Security & Access groups tenant SSO, MFA, password policy,
// sessions, IP allowlist, access policies, temporary/emergency access and
// access reviews under one admin area. Each entry maps to a page under
// /admin/security/*. Screens surface the real backend where one exists (MFA
// enrollment, password change) and show honest "not yet available" states
// where the platform cannot enforce the capability — no settings are faked.
export const SECURITY_CHILDREN: NavChild[] = [
  { label: "Overview", href: "/admin/security" },
  { label: "Single sign-on (SSO)", href: "/admin/security/sso" },
  { label: "Multi-factor auth", href: "/admin/security/mfa" },
  { label: "Password policy", href: "/admin/security/password" },
  { label: "Sessions", href: "/admin/security/sessions" },
  { label: "IP allowlist", href: "/admin/security/ip-allowlist" },
  { label: "Access policies", href: "/admin/security/access-policies" },
  { label: "Temporary access", href: "/admin/security/temporary-access" },
  { label: "Emergency access", href: "/admin/security/emergency-access" },
  { label: "Access reviews", href: "/admin/security/access-reviews" },
]

// SPECS 67–74 — Data governance groups the central tenant audit log,
// classification, field security, retention, legal holds, and the
// import/export centers under one admin area. Each entry maps to a page
// under /admin/governance/*.
export const GOVERNANCE_CHILDREN: NavChild[] = [
  { label: "Audit log", href: "/admin/governance" },
  { label: "Classification", href: "/admin/governance/classification" },
  { label: "Field security", href: "/admin/governance/field-security" },
  { label: "Retention", href: "/admin/governance/retention" },
  { label: "Legal holds", href: "/admin/governance/legal-holds" },
  { label: "Import center", href: "/admin/governance/import-center" },
  { label: "Export center", href: "/admin/governance/export-center" },
]

// Subscription & Billing — a dedicated admin module that sits directly below
// Administration in the sidebar. Every entry maps to a page under
// /modules/billing/* so the whole billing lifecycle (plans, subscriptions,
// invoicing, payments, reconciliation, reporting) is reachable from one place.
export const BILLING_CHILDREN: NavChild[] = [
  { label: "Subscription Management", href: "/modules/billing/subscriptions" },
  { label: "Plan Management", href: "/modules/billing/plans" },
  { label: "Feature Entitlements", href: "/modules/billing/entitlements" },
  { label: "Usage Metering", href: "/modules/billing/usage-metering" },
  { label: "Billing", href: "/modules/billing/billing" },
  { label: "Payment Gateways", href: "/modules/billing/payment-gateways" },
  { label: "Payment Webhooks", href: "/modules/billing/payment-webhooks" },
  { label: "Invoices & Credit Notes", href: "/modules/billing/invoices" },
  { label: "Renewals", href: "/modules/billing/renewals" },
  { label: "Customer Billing Portal", href: "/modules/billing/customer-portal" },
  { label: "Coupons & Discounts", href: "/modules/billing/coupons" },
  { label: "Credits & Adjustments", href: "/modules/billing/credits" },
  { label: "Refunds", href: "/modules/billing/refunds" },
  { label: "Payment Reconciliation", href: "/modules/billing/reconciliation" },
  { label: "Billing Settings", href: "/modules/billing/settings" },
  { label: "Billing Reports", href: "/modules/billing/reports" },
]

// SPECS 1/3/4/5 — The Muenot platform / super-admin console lives in its own
// route tree (`/platform`, gated on the platform axis). Surfacing it as a
// single Administration entry connects that already-built UI to the sidebar
// WITHOUT merging it into the tenant Administration pages — the platform vs
// tenant boundary (SPEC 3) is preserved because the link is only added for
// users who actually carry a platform role.
const PLATFORM_CONSOLE_CHILD: NavChild = { label: "Platform console", href: "/platform" }

/**
 * Build the workspace sidebar navigation for a signed-in user. Shared by the
 * workspace layout and the /admin layout so both render an identical sidebar —
 * clicking an Administration entry no longer redirects into a separate console
 * shell with a different nav.
 */
export async function buildWorkspaceNav(
  session: SessionPayload,
  settings: Record<string, string | undefined>,
): Promise<NavItem[]> {
  const HIDDEN_MODULES = new Set(["biolinks", "biometric", "letter", "monitor-center", "monitor center"])
  const modules = (await getUserAccessibleModules(session.userId, session.role))
    .filter((m) => !HIDDEN_MODULES.has(m.slug.toLowerCase()) && !HIDDEN_MODULES.has(m.name.toLowerCase()))
    .filter((m) => settingEnabled(settings[`module.${m.slug.toLowerCase()}`]))

  const canAccess = await getFeatureChecker(session.userId, session.role)

  const buildChildren = (nodes: FeatureChild[]): NavChild[] =>
    nodes.flatMap<NavChild>((c) => {
      if (c.children && c.children.length > 0) {
        const sub = buildChildren(c.children)
        return sub.length > 0 ? [{ label: c.label, children: sub }] : []
      }
      return c.feature && !canAccess(c.feature) ? [] : [{ label: c.label, href: c.href }]
    })

  const navItems: NavItem[] = [
    { label: "Dashboard", href: "/dashboard", icon: <LayoutDashboard className="size-4" /> },
    ...modules.map((m) => {
      const item: NavItem = {
        label: m.slug === "assets" ? "Assets & Subscriptions" : m.name,
        href: `/modules/${m.slug}`,
        icon: moduleIcons[m.slug] ?? <Settings2 className="size-4" />,
      }
      if (["hr", "sales", "finance", "recruitment", "operations", "clients", "products", "legal", "assets"].includes(m.slug)) {
        const source =
          m.slug === "hr"
            ? HR_CHILDREN
            : m.slug === "finance"
              ? FINANCE_CHILDREN
              : m.slug === "recruitment"
                ? RECRUITMENT_CHILDREN
                : m.slug === "operations"
                  ? OPERATIONS_CHILDREN
                  : m.slug === "clients"
                    ? CLIENTS_CHILDREN
                    : m.slug === "products"
                      ? PRODUCTS_CHILDREN
                      : m.slug === "legal"
                        ? LEGAL_CHILDREN
                        : m.slug === "assets"
                          ? ASSETS_CHILDREN
                          : SALES_CHILDREN
        const children = buildChildren(source as FeatureChild[])
        if (children.length > 0) item.children = children
      }
      return item
    }),
  ]

  // WhatsApp is its own top-level module (not stored in the modules table).
  if (!navItems.some((i) => i.href === "/modules/whatsapp")) {
    const whatsappItem: NavItem = {
      label: "WhatsApp",
      href: "/modules/whatsapp",
      icon: <MessageCircle className="size-4" />,
    }
    const messagesIndex = navItems.findIndex((i) => i.href === "/modules/messages")
    if (messagesIndex >= 0) navItems.splice(messagesIndex + 1, 0, whatsappItem)
    else navItems.push(whatsappItem)
  }

  // Inject the Management module (GLPI-style master data — not stored in the
  // modules table). Groups the 13 management entities under one expandable
  // sidebar entry, each routing to /modules/management/<entity>.
  if (!navItems.some((i) => i.href === "/modules/management")) {
    navItems.push({
      label: "Management",
      href: "/modules/management",
      icon: <ClipboardList className="size-4" />,
      children: MANAGEMENT_ENTITIES.map((e) => ({
        label: e.label,
        href: `/modules/management/${e.key}`,
      })),
    })
  }

  // Inject the Marketing module (not stored in the modules table).
  if (!navItems.some((i) => i.href === "/modules/marketing")) {
    const marketingChildren = buildChildren(MARKETING_CHILDREN)
    if (marketingChildren.length > 0) {
      navItems.push({
        label: "Marketing",
        href: "/modules/marketing",
        icon: <Megaphone className="size-4" />,
        children: marketingChildren,
      })
    }
  }

  // Administration console — restricted to platform/tenant admins. Groups every
  // admin management page under a single expandable entry so they are reachable
  // from the workspace sidebar and open in the same shell (no redirect).
  if (session.role === "admin") {
    const isPlatformUser = session.platformRole != null && session.platformRole !== "none"
    const adminChildren = isPlatformUser
      ? [...ADMINISTRATION_CHILDREN, PLATFORM_CONSOLE_CHILD]
      : ADMINISTRATION_CHILDREN
    navItems.push({
      label: "Administration",
      href: "/admin",
      icon: <ShieldCheck className="size-4" />,
      children: adminChildren,
    })

    // Automation Center sits directly below Administration and is likewise
    // restricted to admins. It surfaces the existing workflow engine plus the
    // event / notification / email monitoring pages under one expandable entry.
    navItems.push({
      label: "Automation",
      href: "/admin/automation",
      icon: <Workflow className="size-4" />,
      children: AUTOMATION_CHILDREN,
    })

    // Security & Access sits directly below Automation and is likewise
    // restricted to admins. It groups tenant SSO, MFA, password policy,
    // sessions, IP allowlist, access/temporary/emergency access and access
    // reviews under one expandable entry.
    navItems.push({
      label: "Security & Access",
      href: "/admin/security",
      icon: <ShieldCheck className="size-4" />,
      children: SECURITY_CHILDREN,
    })

    // Data governance sits directly below Security & Access and is likewise
    // restricted to admins. It groups the central audit log, classification,
    // field security, retention, legal holds and import/export centers.
    navItems.push({
      label: "Data Governance",
      href: "/admin/governance",
      icon: <ShieldCheck className="size-4" />,
      children: GOVERNANCE_CHILDREN,
    })

    // Subscription & Billing sits directly below Administration and is likewise
    // restricted to admins.
    navItems.push({
      label: "Subscription & Billing",
      href: "/modules/billing",
      icon: <CreditCard className="size-4" />,
      children: BILLING_CHILDREN,
    })

    // Storage is its own top-level admin module (moved out of Subscription &
    // Billing). Customer-owned object storage connections are managed here.
    navItems.push({
      label: "Storage",
      href: "/modules/storage",
      icon: <HardDrive className="size-4" />,
    })
  }

  // Optional custom sidebar link driven by Custom Link Settings.
  if (settingEnabled(settings["customlink.enabled"], false) && settings["customlink.url"]) {
    navItems.push({
      label: settings["customlink.label"] || "Custom Link",
      href: settings["customlink.url"]!,
      icon: <ExternalLink className="size-4" />,
      external: true,
      openInNewTab: settingEnabled(settings["customlink.open_new_tab"], true),
    })
  }

  return navItems
}
