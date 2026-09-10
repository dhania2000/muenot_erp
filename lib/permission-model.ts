// =============================================================
// Worksuite-style permission model
// -------------------------------------------------------------
// Mirrors demo.worksuite.biz/account/employees/:id?tab=permissions
//
// Every permission "module" (a data area, e.g. Employees, Leads,
// Attendance) has four actions — Add / View / Update / Delete — and
// each action carries a record-level SCOPE:
//
//   none  -> no access
//   all   -> every record
//   added -> only records this user created  (created_by/added_by)
//   owned -> only records assigned to / owned by this user (assigned_to)
//   both  -> records the user added OR owns
//
// The `scope` config below tells the enforcement engine which columns
// represent "added" and "owned" for each module's primary table, so it
// can build the correct SQL WHERE fragment for list/detail queries.
// =============================================================

export const PERMISSION_SCOPES = ["none", "all", "added", "owned", "both"] as const
export type PermissionScope = (typeof PERMISSION_SCOPES)[number]

export const PERMISSION_ACTIONS = ["add", "view", "update", "delete"] as const
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number]

export type ModulePermission = Record<PermissionAction, PermissionScope>
export type PermissionMatrix = Record<string, ModulePermission>

/** Ownership columns for a module's primary table, used for record-level scoping. */
export type ScopeConfig = {
  /** Primary table the module reads from. */
  table: string
  /** Column holding the creator's user id ("added" scope). */
  addedBy?: string
  /** Column holding the assignee/owner user id ("owned" scope). */
  ownedBy?: string
}

export type PermissionModule = {
  key: string
  label: string
  /** Top-level app module (matches `modules.slug`) — used for sidebar gating. */
  group: string
  /** Keywords used to map legacy feature slugs onto this module. */
  aliases: string[]
  scope: ScopeConfig
}

export type PermissionGroup = {
  slug: string
  label: string
  modules: PermissionModule[]
}

/**
 * The full permission catalog, grouped by app module — this drives the
 * matrix rendered on every employee profile's Permissions tab.
 */
export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    slug: "hr",
    label: "HR",
    modules: [
      { key: "hr.employees", label: "Employees", group: "hr", aliases: ["employee"], scope: { table: "hr_employees", addedBy: "created_by" } },
      { key: "hr.documents", label: "Employee Documents", group: "hr", aliases: ["document"], scope: { table: "hr_employee_documents" } },
      { key: "hr.attendance", label: "Attendance", group: "hr", aliases: ["attendance", "regularisation"], scope: { table: "hr_attendance", addedBy: "user_id", ownedBy: "user_id" } },
      { key: "hr.leaves", label: "Leaves", group: "hr", aliases: ["leave"], scope: { table: "hr_leave_requests", addedBy: "created_by", ownedBy: "employee_id" } },
      { key: "hr.shifts", label: "Shifts", group: "hr", aliases: ["shift", "rotation"], scope: { table: "hr_shifts", addedBy: "created_by" } },
      { key: "hr.support", label: "HR Support", group: "hr", aliases: ["support"], scope: { table: "hr_support_tickets", addedBy: "created_by", ownedBy: "assigned_to" } },
      { key: "hr.offboarding", label: "Offboarding", group: "hr", aliases: ["offboarding", "exit"], scope: { table: "hr_offboarding", addedBy: "created_by" } },
      { key: "hr.master", label: "Promotions & Awards", group: "hr", aliases: ["master", "promotion", "award", "appreciation"], scope: { table: "hr_master_records", addedBy: "created_by" } },
      // NOTE: keep "*_templates" modules BEFORE their plain counterparts so the
      // feature-slug resolver matches the more specific alias first.
      { key: "hr.email_templates", label: "HR Email Templates", group: "hr", aliases: ["email_template"], scope: { table: "hr_email_templates" } },
      { key: "hr.emails", label: "HR Emails", group: "hr", aliases: ["email"], scope: { table: "hr_emails" } },
      { key: "hr.letter_templates", label: "Letter Templates", group: "hr", aliases: ["letter_template"], scope: { table: "hr_letter_templates", addedBy: "created_by" } },
      { key: "hr.letters", label: "Letters", group: "hr", aliases: ["letter"], scope: { table: "hr_letters", addedBy: "created_by" } },
    ],
  },
  {
    slug: "sales",
    label: "Sales",
    modules: [
      { key: "sales.leads", label: "Leads", group: "sales", aliases: ["lead"], scope: { table: "sales_leads", addedBy: "created_by", ownedBy: "assigned_to" } },
      { key: "sales.companies", label: "Companies", group: "sales", aliases: ["compan", "account"], scope: { table: "sales_companies", addedBy: "created_by", ownedBy: "assigned_to" } },
      { key: "sales.meetings", label: "Meetings", group: "sales", aliases: ["meeting"], scope: { table: "sales_meetings", addedBy: "added_by" } },
      { key: "sales.quotations", label: "Quotations", group: "sales", aliases: ["quotation", "quote"], scope: { table: "sales_quotations", addedBy: "added_by" } },
      { key: "sales.contracts", label: "Contracts", group: "sales", aliases: ["contract"], scope: { table: "sales_contracts", addedBy: "added_by" } },
      { key: "sales.onboarding", label: "Client Onboarding", group: "sales", aliases: ["onboarding"], scope: { table: "sales_onboarding", addedBy: "added_by" } },
      { key: "sales.email_templates", label: "Sales Email Templates", group: "sales", aliases: ["email_template"], scope: { table: "sales_email_templates", addedBy: "created_by" } },
      { key: "sales.emails", label: "Sales Emails", group: "sales", aliases: ["email", "call"], scope: { table: "sales_emails" } },
    ],
  },
  {
    slug: "finance",
    label: "Finance",
    modules: [
      // "Sales Invoices" is a Finance sub-module (page lives at /modules/finance/sales-invoices).
      { key: "finance.sales_invoices", label: "Sales Invoices", group: "finance", aliases: ["sales_invoice"], scope: { table: "sales_invoices", addedBy: "created_by" } },
      { key: "finance.purchase_bills", label: "Purchase Bills", group: "finance", aliases: ["purchase", "bill"], scope: { table: "purchase_bills", addedBy: "created_by" } },
      { key: "finance.expenses", label: "Expenses", group: "finance", aliases: ["expense"], scope: { table: "expenses", addedBy: "created_by", ownedBy: "user_id" } },
      { key: "finance.fte_invoices", label: "FTE Invoices", group: "finance", aliases: ["fte"], scope: { table: "fte_invoices", addedBy: "created_by" } },
      { key: "finance.freelance_invoices", label: "Freelance Invoices", group: "finance", aliases: ["freelance"], scope: { table: "freelance_invoices", addedBy: "created_by" } },
      { key: "finance.bank_transactions", label: "Bank Transactions", group: "finance", aliases: ["bank_transaction", "transaction"], scope: { table: "bank_transactions", addedBy: "created_by" } },
      { key: "finance.bank_cash", label: "Bank & Cash", group: "finance", aliases: ["bank_cash"], scope: { table: "finance_accounts", addedBy: "created_by" } },
      { key: "finance.chart_of_accounts", label: "Chart of Accounts", group: "finance", aliases: ["chart"], scope: { table: "chart_of_accounts", addedBy: "created_by" } },
      { key: "finance.customers_vendors", label: "Customer / Vendor", group: "finance", aliases: ["customer", "vendor"], scope: { table: "customers_vendors", addedBy: "created_by" } },
      { key: "finance.gst_filing", label: "GST Filing", group: "finance", aliases: ["gst"], scope: { table: "gst_filings" } },
      { key: "finance.tds_filing", label: "TDS Filing", group: "finance", aliases: ["tds"], scope: { table: "tds_filings" } },
      { key: "finance.journal", label: "Journal & Ledger", group: "finance", aliases: ["journal", "ledger"], scope: { table: "finance_records", addedBy: "created_by" } },
      { key: "finance.reports", label: "Financial Reports", group: "finance", aliases: ["financial_report", "report"], scope: { table: "finance_records" } },
      { key: "finance.email_templates", label: "Finance Email Templates", group: "finance", aliases: ["email_template"], scope: { table: "finance_email_templates" } },
      { key: "finance.emails", label: "Finance Emails", group: "finance", aliases: ["email"], scope: { table: "finance_emails", addedBy: "created_by" } },
    ],
  },
  {
    slug: "recruitment",
    label: "Recruitment",
    modules: [
      { key: "recruitment.requisitions", label: "Job Requisitions", group: "recruitment", aliases: ["requisition", "job", "application"], scope: { table: "recruitment_requisitions", addedBy: "created_by" } },
      { key: "recruitment.candidates", label: "Candidates", group: "recruitment", aliases: ["candidate", "screening", "source", "call"], scope: { table: "recruitment_candidates", addedBy: "created_by", ownedBy: "assigned_to" } },
      { key: "recruitment.interviews", label: "Interviews & Assessments", group: "recruitment", aliases: ["interview", "assessment"], scope: { table: "recruitment_interviews", addedBy: "created_by" } },
      { key: "recruitment.offers", label: "Selection & Offers", group: "recruitment", aliases: ["offer", "selection"], scope: { table: "recruitment_offers", addedBy: "created_by" } },
      { key: "recruitment.skills", label: "Job Skills", group: "recruitment", aliases: ["skill"], scope: { table: "recruit_job_skills", addedBy: "created_by" } },
      { key: "recruitment.reports", label: "Recruitment Reports", group: "recruitment", aliases: ["report"], scope: { table: "recruit_jobs" } },
      { key: "recruitment.email_templates", label: "Recruitment Email Templates", group: "recruitment", aliases: ["email_template"], scope: { table: "recruit_email_templates", addedBy: "created_by" } },
      { key: "recruitment.emails", label: "Recruitment Emails", group: "recruitment", aliases: ["email"], scope: { table: "recruit_emails", addedBy: "created_by" } },
    ],
  },
  {
    slug: "operations",
    label: "Operations",
    modules: [
      { key: "operations.resources", label: "Resources", group: "operations", aliases: ["resource"], scope: { table: "operations_resources", addedBy: "created_by" } },
      { key: "operations.projects", label: "Projects", group: "operations", aliases: ["project"], scope: { table: "operations_projects", addedBy: "created_by", ownedBy: "assigned_to" } },
      { key: "operations.allocations", label: "Allocations", group: "operations", aliases: ["allocation"], scope: { table: "operations_allocations", addedBy: "created_by" } },
      { key: "operations.quality", label: "Quality & SLA Reviews", group: "operations", aliases: ["quality", "sla", "review"], scope: { table: "operations_quality_reviews", addedBy: "created_by" } },
      { key: "operations.issues", label: "Issues", group: "operations", aliases: ["issue"], scope: { table: "operations_issues", addedBy: "created_by", ownedBy: "assigned_to" } },
      { key: "operations.email_templates", label: "Operations Email Templates", group: "operations", aliases: ["email_template"], scope: { table: "operations_email_templates" } },
      { key: "operations.emails", label: "Operations Emails", group: "operations", aliases: ["email"], scope: { table: "operations_emails", addedBy: "created_by" } },
    ],
  },
  {
    slug: "clients",
    label: "Clients",
    modules: [
      { key: "clients.clients", label: "Clients", group: "clients", aliases: ["client"], scope: { table: "clients", addedBy: "created_by", ownedBy: "account_manager_id" } },
    ],
  },
  {
    slug: "tickets",
    label: "Tickets",
    modules: [
      { key: "tickets.tickets", label: "Tickets", group: "tickets", aliases: ["ticket"], scope: { table: "tickets", addedBy: "created_by", ownedBy: "assigned_to" } },
    ],
  },
  {
    slug: "products",
    label: "Products",
    modules: [
      { key: "products.products", label: "Products", group: "products", aliases: ["product"], scope: { table: "products", addedBy: "created_by" } },
    ],
  },
  {
    slug: "orders",
    label: "Orders",
    modules: [
      { key: "orders.orders", label: "Orders", group: "orders", aliases: ["order"], scope: { table: "orders", addedBy: "created_by", ownedBy: "assigned_to" } },
    ],
  },
  {
    slug: "legal",
    label: "Legal",
    modules: [
      { key: "legal.contracts", label: "Contracts", group: "legal", aliases: ["contract"], scope: { table: "legal_contracts", addedBy: "created_by" } },
      { key: "legal.esign", label: "Esign", group: "legal", aliases: ["esign", "sign", "signature"], scope: { table: "legal_esign_requests", addedBy: "created_by" } },
    ],
  },
]

export const PERMISSION_MODULES: PermissionModule[] = PERMISSION_GROUPS.flatMap((g) => g.modules)

const MODULE_BY_KEY = new Map(PERMISSION_MODULES.map((m) => [m.key, m]))

export function getPermissionModule(key: string): PermissionModule | undefined {
  return MODULE_BY_KEY.get(key)
}

/** An empty permission (everything set to "none"). */
export function emptyModulePermission(): ModulePermission {
  return { add: "none", view: "none", update: "none", delete: "none" }
}

/** A full permission (everything set to "all") — used for "select all". */
export function fullModulePermission(): ModulePermission {
  return { add: "all", view: "all", update: "all", delete: "all" }
}

/** Build a complete matrix with a default value for every module. */
export function defaultMatrix(scope: PermissionScope = "none"): PermissionMatrix {
  const value: ModulePermission = { add: scope, view: scope, update: scope, delete: scope }
  const matrix: PermissionMatrix = {}
  for (const m of PERMISSION_MODULES) matrix[m.key] = { ...value }
  return matrix
}

/**
 * Resolve a legacy feature slug (e.g. "hr.view_employees",
 * "sales.manage_leads") onto a permission module + action so the existing
 * sidebar/page gating can be driven from the new matrix.
 */
export function resolveFeatureSlug(slug: string): { moduleKey: string; action: PermissionAction } | null {
  const [group, rest] = slug.split(".")
  if (!group || !rest) return null

  const viewVerbs = ["view", "list", "read", "get", "make", "download", "export"]
  const verb = rest.split("_")[0]
  const action: PermissionAction = viewVerbs.includes(verb) ? "view" : "update"

  const groupModules = PERMISSION_MODULES.filter((m) => m.group === group)
  if (groupModules.length === 0) return null

  const haystack = rest.replace(/^[a-z]+_/, "")
  const match =
    groupModules.find((m) => m.aliases.some((a) => haystack.includes(a) || rest.includes(a))) ??
    groupModules[0]

  return { moduleKey: match.key, action }
}
