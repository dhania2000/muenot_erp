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

/**
 * A module-specific EXTENDED action (beyond the four CRUD verbs). Used to give
 * high-risk workflows their own separately-grantable permission — e.g. GST
 * Filing separates "File Return", "Record Tax Payment", "Reopen Period" and
 * "Amend Return" from the generic Add/View/Update/Delete so that plain Update
 * can never file, pay, reopen or amend a return.
 *
 * `fallback` is the base CRUD action an extended grant DERIVES from when an
 * admin has a permission matrix configured but has not yet set this extended
 * action explicitly. Destructive/irreversible actions fall back to `delete`
 * (the strongest base verb) so a mere Update never implies them; preparatory
 * actions fall back to `update`, and read-only ones to `view`. Once an admin
 * sets the extended action explicitly, that value wins.
 *
 * `scoped` marks whether All/Added/Owned/Both record-scoping is meaningful for
 * the action. GST returns are period-level, org-wide documents with no
 * per-user owner, so their extended actions are simple Allowed/None grants.
 */
export type ExtendedAction = {
  key: string
  label: string
  fallback: PermissionAction
  scoped: boolean
  description?: string
}

/**
 * Phase 44 — GST Filing granular action permissions. These live ALONGSIDE the
 * existing Add/View/Update/Delete for the GST Filing module; they never
 * replace them. A filed return can only move forward through these gated
 * actions (reopen/amend/payment), never via a generic Update/Delete.
 */
export const GST_FILING_EXTRA_ACTIONS: ExtendedAction[] = [
  { key: "prepare_return", label: "Prepare Return", fallback: "update", scoped: false, description: "Materialise a draft return from the derived summary." },
  { key: "review_return", label: "Review Return", fallback: "update", scoped: false, description: "Submit for review and mark a return reviewed." },
  { key: "file_return", label: "File Return", fallback: "delete", scoped: false, description: "File the return (including Nil returns) with the portal ARN." },
  { key: "record_payment", label: "Record Tax Payment", fallback: "delete", scoped: false, description: "Record tax paid and move the return through its payment lifecycle." },
  { key: "reopen_period", label: "Reopen Period", fallback: "delete", scoped: false, description: "Reopen a pre-file return back to Draft." },
  { key: "amend_return", label: "Amend Return", fallback: "delete", scoped: false, description: "Amend a filed return (archives the prior snapshot)." },
  { key: "cancel_return", label: "Cancel Return", fallback: "delete", scoped: false, description: "Cancel/void a prepared return." },
  { key: "export_return", label: "Export Return", fallback: "view", scoped: false, description: "Export the return and the CA hand-off package." },
  { key: "reconcile_gst", label: "Reconcile GST", fallback: "update", scoped: false, description: "Run and act on output-GST / GSTR-2B reconciliation." },
  { key: "manage_itc", label: "Manage ITC", fallback: "update", scoped: false, description: "Manage input tax credit — claim/unclaim and adjust the GST Input / ITC register." },
  { key: "manage_reversal", label: "Manage ITC Reversal", fallback: "update", scoped: false, description: "Record and manage ITC reversals that feed GSTR-3B and net liability." },
  { key: "manage_filing", label: "Manage Filing", fallback: "delete", scoped: false, description: "Close/lock a period and manage filing configuration." },
  { key: "view_sensitive", label: "View Sensitive Tax Data", fallback: "view", scoped: false, description: "View sensitive tax data such as the audit trail and ARNs." },
]

/**
 * Product & Inventory extended actions (Phase 44). They live ALONGSIDE the base
 * Add/View/Update/Delete on the Products module and gate the sensitive or
 * high-impact operations: moving stock, seeing cost/margin, and bulk data ops.
 */
export const PRODUCT_EXTRA_ACTIONS: ExtendedAction[] = [
  { key: "adjust_stock", label: "Adjust Stock", fallback: "update", scoped: false, description: "Manually increase, decrease or set on-hand stock with a reason." },
  { key: "view_cost", label: "View Cost Price", fallback: "view", scoped: false, description: "View purchase / cost price and inventory cost valuation." },
  { key: "view_margin", label: "View Margin", fallback: "view", scoped: false, description: "View profit margin between cost and selling price." },
  { key: "change_status", label: "Change Status", fallback: "delete", scoped: false, description: "Activate, deactivate or discontinue a product." },
  { key: "manage_categories", label: "Manage Categories", fallback: "update", scoped: false, description: "Add or retire product categories and subcategories." },
  { key: "import_export", label: "Import / Export", fallback: "delete", scoped: false, description: "Bulk import products and export the catalog." },
  { key: "manage_settings", label: "Manage Settings", fallback: "delete", scoped: false, description: "Tune module defaults such as negative-stock policy and reorder thresholds." },
]

/**
 * TDS Filing granular action permissions — the compliance chain that follows
 * deduction (liability → challan → return → certificate → reconciliation).
 * Like the GST set, these live ALONGSIDE Add/View/Update/Delete and gate the
 * high-risk, largely irreversible statutory steps so a plain Update can never
 * file a return, record a government deposit, or issue a certificate.
 */
export const TDS_FILING_EXTRA_ACTIONS: ExtendedAction[] = [
  { key: "prepare_return", label: "Prepare TDS Return", fallback: "update", scoped: false, description: "Materialise a draft monthly filing / quarterly 24Q/26Q statement from the derived liability." },
  { key: "review_return", label: "Review TDS Return", fallback: "update", scoped: false, description: "Submit a prepared return for review and mark it reviewed before filing." },
  { key: "file_return", label: "File TDS Return", fallback: "delete", scoped: false, description: "File a monthly filing or a quarterly 24Q/26Q return." },
  { key: "record_challan", label: "Record Challan", fallback: "delete", scoped: false, description: "Record a government TDS challan / deposit against a period." },
  { key: "record_payment", label: "Record TDS Payment", fallback: "delete", scoped: false, description: "Record a TDS deposit/payment and allocate it against the period liability." },
  { key: "issue_certificate", label: "Issue Certificate", fallback: "delete", scoped: false, description: "Generate and issue Form 16 / 16A certificates to deductees." },
  { key: "reconcile_tds", label: "Reconcile TDS", fallback: "update", scoped: false, description: "Run the deducted / deposited / reported three-way reconciliation." },
  { key: "amend_return", label: "Amend / Correct Return", fallback: "delete", scoped: false, description: "File a correction statement against an already-filed return (archives the prior snapshot)." },
  { key: "reopen_period", label: "Reopen Period", fallback: "delete", scoped: false, description: "Reopen a locked / closed period back to an editable state." },
  { key: "manage_rules", label: "Manage TDS Rules", fallback: "delete", scoped: false, description: "Add, edit or retire section rates and thresholds in the TDS rule master." },
  { key: "export_return", label: "Export TDS Return", fallback: "view", scoped: false, description: "Export the return, challan register, certificate hand-off pack and CA review package." },
  { key: "view_sensitive", label: "View Sensitive Tax Data", fallback: "view", scoped: false, description: "View sensitive TDS data such as full PANs, the audit trail and TRACES tokens." },
]

/**
 * Journal & Ledger granular action — the export registers (Phase 51). Lives
 * ALONGSIDE the module's Add/View/Update/Delete: a read-only hand-off action
 * that falls back to `view`, so anyone who can view journals can pull the
 * Register / Detail / Account-wise / Voucher-wise / Period-wise exports, and
 * it can be revoked independently without touching view access.
 */
export const JOURNAL_EXTRA_ACTIONS: ExtendedAction[] = [
  { key: "export", label: "Export Journals", fallback: "view", scoped: false, description: "Export the journal register, detail, account-wise, voucher-wise and period-wise datasets." },
]

/**
 * Financial Reports granular actions. Viewing a report is governed by the
 * module's base `view` scope; these two extended grants separate the ability to
 * take a report OUT of the system from merely reading it, so an admin can let
 * someone view reports on-screen while revoking downloads and/or emailing.
 * Both fall back to `view`, so a viewer keeps export + email by default until
 * an admin explicitly sets either to "none".
 */
export const REPORTS_EXTRA_ACTIONS: ExtendedAction[] = [
  { key: "export_report", label: "Export / Download Report", fallback: "view", scoped: false, description: "Download a report as PDF, Excel or CSV." },
  { key: "email_report", label: "Email Report", fallback: "view", scoped: false, description: "Email a report snapshot to a recipient." },
]

/**
 * Employee Assets granular actions. The base Add/View/Update/Delete scopes
 * govern the assignment records themselves; these carve the asset lifecycle
 * operations out of a plain Update so an admin can e.g. let someone assign and
 * return assets but not mark them lost/damaged, or grant export independently.
 * Assign falls back to `add`; return / reassign / repair fall back to `update`;
 * the loss events fall back to `delete`; export falls back to `view`.
 */
export const EMPLOYEE_ASSET_EXTRA_ACTIONS: ExtendedAction[] = [
  { key: "assign", label: "Assign Asset", fallback: "add", scoped: true, description: "Assign a company fixed asset to an employee." },
  { key: "return_asset", label: "Return Asset", fallback: "update", scoped: true, description: "Record the return of an assigned asset." },
  { key: "reassign", label: "Reassign Asset", fallback: "update", scoped: true, description: "Return the current holder and reassign the asset to another employee." },
  { key: "mark_status", label: "Mark Lost / Damaged / Repair", fallback: "delete", scoped: true, description: "Flag an assigned asset as lost, damaged or under repair." },
  { key: "export", label: "Export Assignments", fallback: "view", scoped: false, description: "Export the employee-asset assignment register as CSV." },
]

/**
 * Company Subscriptions granular actions. The base Add/View/Update/Delete scopes
 * govern the subscription records; these separate the recurring-service
 * lifecycle (seat assign/revoke, renew, cancel/suspend) and CSV export so they
 * can be granted independently of a plain Update.
 */
export const COMPANY_SUBSCRIPTION_EXTRA_ACTIONS: ExtendedAction[] = [
  { key: "assign_seat", label: "Assign Seat", fallback: "add", scoped: true, description: "Allocate a subscription seat/license to an employee." },
  { key: "revoke_seat", label: "Revoke Seat", fallback: "update", scoped: true, description: "Revoke a subscription seat from an employee." },
  { key: "renew", label: "Renew Subscription", fallback: "update", scoped: true, description: "Renew a subscription for another billing cycle." },
  { key: "cancel", label: "Cancel / Suspend", fallback: "delete", scoped: true, description: "Cancel, suspend or reactivate a subscription." },
  { key: "manage_documents", label: "Manage Documents", fallback: "update", scoped: true, description: "Attach or remove subscription documents." },
  { key: "export", label: "Export Register", fallback: "view", scoped: false, description: "Export the company subscription register as CSV." },
]

/**
 * Phase 53 — Interviews & Assessments granular action permissions. These live
 * ALONGSIDE the module's Add/View/Update/Delete and carve the scheduling
 * lifecycle out of the generic verbs, so a plain Update can neither reschedule
 * nor cancel an interview and a plain Add cannot silently push calendar invites.
 * They are `scoped` because interviews carry a real per-user owner (created_by),
 * so an admin can e.g. let a coordinator reschedule only interviews they own.
 * Destructive/irreversible steps fall back to `delete`; preparatory ones to the
 * base verb they extend (`add`/`update`).
 */
/**
 * Screen Activity Monitoring extended actions. Base View/Add/Update/Delete
 * scopes already encode "View Own / Team / All" (via none/owned/added/all). The
 * privileged operations below are separable so an HR viewer can be granted read
 * access without export, retention-purge or settings rights.
 */
export const SCREEN_MONITORING_EXTRA_ACTIONS: ExtendedAction[] = [
  { key: "export", label: "Export Monitoring Data", fallback: "view", scoped: false, description: "Export monitoring session metadata (employee, attendance, session, duration, status)." },
  { key: "download_screenshot", label: "Download Screenshot", fallback: "view", scoped: false, description: "Download individual captured screenshots (audited)." },
  { key: "manage_retention", label: "Retention Management", fallback: "delete", scoped: false, description: "Delete screenshots and manage retention purges." },
  { key: "manage_settings", label: "Monitoring Settings", fallback: "delete", scoped: false, description: "Configure capture interval, image quality and retention window." },
]

export const INTERVIEW_EXTRA_ACTIONS: ExtendedAction[] = [
  { key: "schedule_interview", label: "Schedule Interview", fallback: "add", scoped: true, description: "Schedule an interview and issue the calendar invite / notifications." },
  { key: "reschedule_interview", label: "Reschedule Interview", fallback: "update", scoped: true, description: "Move a scheduled interview to a new date/time and re-issue invites." },
  { key: "cancel_interview", label: "Cancel Interview", fallback: "delete", scoped: true, description: "Cancel a scheduled interview and withdraw its calendar invite." },
  { key: "record_outcome", label: "Record Interview Outcome", fallback: "update", scoped: true, description: "Record a pass/fail outcome that advances or rejects the candidate." },
]

/**
 * Phase 53 — Selection & Offers granular action permissions. Sending, revoking
 * and (irreversibly) converting an accepted offer into an employee are gated
 * separately from a plain Update/Delete. `convert_offer` creates HR + onboarding
 * data, so it falls back to `delete`; `send_offer` falls back to `update`.
 */
export const OFFER_EXTRA_ACTIONS: ExtendedAction[] = [
  { key: "send_offer", label: "Send Offer", fallback: "update", scoped: true, description: "Issue / release an offer to a candidate." },
  { key: "revoke_offer", label: "Revoke Offer", fallback: "delete", scoped: true, description: "Withdraw or rescind a live offer." },
  { key: "convert_offer", label: "Convert Offer to Employee", fallback: "delete", scoped: true, description: "Convert an accepted offer into an employee record (creates HR + onboarding data)." },
]

export type ModulePermission = {
  add: PermissionScope
  view: PermissionScope
  update: PermissionScope
  delete: PermissionScope
  /**
   * Module-specific extended-action grants, keyed by `ExtendedAction.key`.
   * Only present for modules that declare `extraActions`.
   */
  extra?: Record<string, PermissionScope>
}
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
  /** Module-specific extended actions beyond Add/View/Update/Delete. */
  extraActions?: ExtendedAction[]
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
      // Dashboard rows carry no record-level ownership — only "view" is meaningful.
      { key: "hr.dashboard", label: "HR Dashboard", group: "hr", aliases: ["dashboard"], scope: { table: "hr_employees" } },
      { key: "hr.employees", label: "Employees", group: "hr", aliases: ["employee"], scope: { table: "hr_employees", addedBy: "created_by" } },
      { key: "hr.documents", label: "Employee Documents", group: "hr", aliases: ["document"], scope: { table: "hr_employee_documents" } },
      { key: "hr.attendance", label: "Attendance", group: "hr", aliases: ["attendance", "regularisation"], scope: { table: "hr_attendance", addedBy: "user_id", ownedBy: "user_id" } },
      { key: "hr.screen_monitoring", label: "Screen Activity Monitoring", group: "hr", aliases: ["screen_monitoring", "screen", "monitoring"], scope: { table: "screen_monitoring_sessions", addedBy: "user_id", ownedBy: "user_id" }, extraActions: SCREEN_MONITORING_EXTRA_ACTIONS },
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
      { key: "sales.dashboard", label: "Sales Dashboard", group: "sales", aliases: ["dashboard"], scope: { table: "sales_leads" } },
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
      { key: "finance.dashboard", label: "Finance Dashboard", group: "finance", aliases: ["dashboard"], scope: { table: "finance_records" } },
      // "Sales Invoices" is a Finance sub-module (page lives at /modules/finance/sales-invoices).
      { key: "finance.sales_invoices", label: "Sales Invoices", group: "finance", aliases: ["sales_invoice"], scope: { table: "sales_invoices", addedBy: "created_by" } },
      { key: "finance.purchase_bills", label: "Purchase Bills", group: "finance", aliases: ["purchase", "bill"], scope: { table: "purchase_bills", addedBy: "created_by" } },
      { key: "finance.expenses", label: "Expenses", group: "finance", aliases: ["expense"], scope: { table: "expenses", addedBy: "created_by", ownedBy: "user_id" } },
      { key: "finance.fte_invoices", label: "FTE Invoices", group: "finance", aliases: ["fte"], scope: { table: "fte_invoices", addedBy: "created_by" } },
      { key: "finance.freelance_invoices", label: "Freelance Invoices", group: "finance", aliases: ["freelance"], scope: { table: "freelance_invoices", addedBy: "created_by" } },
      { key: "finance.bank_transactions", label: "Bank Transactions", group: "finance", aliases: ["bank_transaction", "transaction"], scope: { table: "bank_transactions", addedBy: "created_by" } },
      { key: "finance.bank_cash", label: "Bank & Cash", group: "finance", aliases: ["bank_cash"], scope: { table: "finance_accounts", addedBy: "created_by" } },
      { key: "finance.chart_of_accounts", label: "Chart of Accounts", group: "finance", aliases: ["chart"], scope: { table: "chart_of_accounts", addedBy: "created_by" } },
      { key: "finance.customers_vendors", label: "Vendors", group: "finance", aliases: ["customer", "vendor"], scope: { table: "customers_vendors", addedBy: "created_by" } },
      { key: "finance.gst_filing", label: "GST Filing", group: "finance", aliases: ["gst"], scope: { table: "gst_filings" }, extraActions: GST_FILING_EXTRA_ACTIONS },
      { key: "finance.tds_filing", label: "TDS Filing", group: "finance", aliases: ["tds"], scope: { table: "tds_filings" }, extraActions: TDS_FILING_EXTRA_ACTIONS },
      { key: "finance.journal", label: "Journal & Ledger", group: "finance", aliases: ["journal", "ledger"], scope: { table: "finance_records", addedBy: "created_by" }, extraActions: JOURNAL_EXTRA_ACTIONS },
      { key: "finance.reports", label: "Financial Reports", group: "finance", aliases: ["financial_report", "report"], scope: { table: "finance_records" }, extraActions: REPORTS_EXTRA_ACTIONS },
      { key: "finance.email_templates", label: "Finance Email Templates", group: "finance", aliases: ["email_template"], scope: { table: "finance_email_templates" } },
      { key: "finance.emails", label: "Finance Emails", group: "finance", aliases: ["email"], scope: { table: "finance_emails", addedBy: "created_by" } },
    ],
  },
  {
    slug: "recruitment",
    label: "Recruitment",
    modules: [
      { key: "recruitment.dashboard", label: "Recruitment Dashboard", group: "recruitment", aliases: ["dashboard"], scope: { table: "recruit_jobs" } },
      { key: "recruitment.requisitions", label: "Job Requisitions", group: "recruitment", aliases: ["requisition", "job", "application"], scope: { table: "recruitment_requisitions", addedBy: "created_by" } },
      { key: "recruitment.candidates", label: "Candidates", group: "recruitment", aliases: ["candidate", "screening", "source", "call"], scope: { table: "recruitment_candidates", addedBy: "created_by", ownedBy: "assigned_to" } },
      { key: "recruitment.interviews", label: "Interviews & Assessments", group: "recruitment", aliases: ["interview", "assessment"], scope: { table: "recruitment_interviews", addedBy: "created_by" }, extraActions: INTERVIEW_EXTRA_ACTIONS },
      { key: "recruitment.offers", label: "Selection & Offers", group: "recruitment", aliases: ["offer", "selection"], scope: { table: "recruitment_offers", addedBy: "created_by" }, extraActions: OFFER_EXTRA_ACTIONS },
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
      { key: "operations.dashboard", label: "Operations Dashboard", group: "operations", aliases: ["dashboard"], scope: { table: "operations_projects" } },
      // --- Expanded Operations sub-modules. Ordered specific-before-generic so
      // resolveFeatureSlug() maps each `operations.view_*` slug to the intended
      // module (e.g. client_deliverables wins over deliverables, sla_monitoring
      // over quality's "sla" alias). Do not reorder without re-checking aliases.
      { key: "operations.milestones", label: "Project Milestones", group: "operations", aliases: ["milestone"], scope: { table: "operations_milestones", addedBy: "created_by" } },
      { key: "operations.client_deliverables", label: "Client Deliverables", group: "operations", aliases: ["client_deliverable"], scope: { table: "operations_client_deliverables", addedBy: "created_by" } },
      { key: "operations.deliverables", label: "Project Deliverables", group: "operations", aliases: ["deliverable"], scope: { table: "operations_deliverables", addedBy: "created_by" } },
      { key: "operations.project_documents", label: "Project Documents", group: "operations", aliases: ["project_document"], scope: { table: "operations_project_documents", addedBy: "created_by" } },
      { key: "operations.tasks", label: "Tasks", group: "operations", aliases: ["task"], scope: { table: "operations_tasks", addedBy: "created_by", ownedBy: "assigned_to" } },
      { key: "operations.work_orders", label: "Work Orders", group: "operations", aliases: ["work_order"], scope: { table: "operations_work_orders", addedBy: "created_by", ownedBy: "assigned_to" } },
      { key: "operations.resource_requests", label: "Resource Requests", group: "operations", aliases: ["resource_request"], scope: { table: "operations_resource_requests", addedBy: "created_by" } },
      { key: "operations.skill_matrix", label: "Skill Matrix", group: "operations", aliases: ["skill"], scope: { table: "operations_skill_matrix", addedBy: "created_by" } },
      { key: "operations.capacity_planning", label: "Capacity Planning", group: "operations", aliases: ["capacity"], scope: { table: "operations_capacity_planning", addedBy: "created_by" } },
      { key: "operations.utilization", label: "Utilization", group: "operations", aliases: ["utilization"], scope: { table: "operations_utilization", addedBy: "created_by" } },
      { key: "operations.timesheets", label: "Timesheets", group: "operations", aliases: ["timesheet"], scope: { table: "operations_timesheets", addedBy: "created_by" } },
      { key: "operations.productivity", label: "Productivity", group: "operations", aliases: ["productivity"], scope: { table: "operations_productivity", addedBy: "created_by" } },
      { key: "operations.scorecards", label: "Quality Scorecards", group: "operations", aliases: ["scorecard"], scope: { table: "operations_scorecards", addedBy: "created_by" } },
      { key: "operations.scorecard_criteria", label: "Scorecard Criteria", group: "operations", aliases: ["scorecard_criteria"], scope: { table: "operations_scorecard_criteria", addedBy: "created_by" } },
      { key: "operations.qa_audits", label: "QA Audits", group: "operations", aliases: ["audit"], scope: { table: "operations_qa_audits", addedBy: "created_by" } },
      { key: "operations.sla_monitoring", label: "SLA Monitoring", group: "operations", aliases: ["sla_monitoring"], scope: { table: "operations_sla_monitoring", addedBy: "created_by" } },
      { key: "operations.corrective_actions", label: "Corrective Actions", group: "operations", aliases: ["corrective"], scope: { table: "operations_corrective_actions", addedBy: "created_by" } },
      { key: "operations.escalations", label: "Escalations", group: "operations", aliases: ["escalation"], scope: { table: "operations_escalations", addedBy: "created_by", ownedBy: "assigned_to" } },
      { key: "operations.root_cause_capa", label: "Root Cause / CAPA", group: "operations", aliases: ["capa"], scope: { table: "operations_root_cause_capa", addedBy: "created_by" } },
      { key: "operations.sops", label: "SOPs", group: "operations", aliases: ["sop"], scope: { table: "operations_sops", addedBy: "created_by" } },
      { key: "operations.checklists", label: "Checklists", group: "operations", aliases: ["checklist"], scope: { table: "operations_checklists", addedBy: "created_by" } },
      { key: "operations.client_approvals", label: "Client Approvals", group: "operations", aliases: ["client_approval"], scope: { table: "operations_client_approvals", addedBy: "created_by" } },
      { key: "operations.approvals", label: "Approvals", group: "operations", aliases: ["approval"], scope: { table: "operations_approvals", addedBy: "created_by" } },
      { key: "operations.client_requirements", label: "Client Requirements", group: "operations", aliases: ["client_requirement", "requirement"], scope: { table: "operations_client_requirements", addedBy: "created_by" } },
      { key: "operations.project_cost", label: "Project Cost", group: "operations", aliases: ["project_cost"], scope: { table: "operations_project_cost", addedBy: "created_by" } },
      { key: "operations.resource_cost", label: "Resource Cost", group: "operations", aliases: ["resource_cost"], scope: { table: "operations_resource_cost", addedBy: "created_by" } },
      { key: "operations.vendor_cost", label: "Vendor Cost", group: "operations", aliases: ["vendor_cost"], scope: { table: "operations_vendor_cost", addedBy: "created_by" } },
      { key: "operations.budget_vs_actual", label: "Budget vs Actual", group: "operations", aliases: ["budget"], scope: { table: "operations_budget_vs_actual", addedBy: "created_by" } },
      { key: "operations.resources", label: "Resources", group: "operations", aliases: ["resource"], scope: { table: "operations_resources", addedBy: "created_by" } },
      { key: "operations.projects", label: "Projects", group: "operations", aliases: ["project"], scope: { table: "operations_projects", addedBy: "created_by", ownedBy: "assigned_to" } },
      { key: "operations.allocations", label: "Allocations", group: "operations", aliases: ["allocation"], scope: { table: "operations_allocations", addedBy: "created_by" } },
      { key: "operations.quality", label: "Quality & SLA Reviews", group: "operations", aliases: ["quality", "sla", "review"], scope: { table: "operations_quality_reviews", addedBy: "created_by" } },
      { key: "operations.issues", label: "Issues", group: "operations", aliases: ["issue"], scope: { table: "operations_issues", addedBy: "created_by", ownedBy: "assigned_to" } },
      { key: "operations.email_templates", label: "Operations Email Templates", group: "operations", aliases: ["email_template"], scope: { table: "operations_email_templates" } },
      { key: "operations.emails", label: "Operations Emails", group: "operations", aliases: ["email"], scope: { table: "operations_emails", addedBy: "created_by" } },
      { key: "operations.meetings", label: "Operations Meetings", group: "operations", aliases: ["meeting"], scope: { table: "operations_meetings", addedBy: "created_by" } },
      { key: "operations.analytics", label: "Operations Analytics", group: "operations", aliases: ["analytics"], scope: { table: "operations_projects" } },
    ],
  },
  {
    slug: "clients",
    label: "Clients",
    modules: [
      { key: "clients.dashboard", label: "Clients Dashboard", group: "clients", aliases: ["dashboard"], scope: { table: "clients" } },
      { key: "clients.clients", label: "Clients", group: "clients", aliases: ["client"], scope: { table: "clients", addedBy: "created_by", ownedBy: "account_manager_id" } },
    ],
  },
  {
    slug: "tickets",
    label: "Tickets",
    modules: [
      { key: "tickets.dashboard", label: "Tickets Dashboard", group: "tickets", aliases: ["dashboard"], scope: { table: "tickets" } },
      { key: "tickets.tickets", label: "Tickets", group: "tickets", aliases: ["ticket"], scope: { table: "tickets", addedBy: "created_by", ownedBy: "assigned_to" } },
    ],
  },
  {
    slug: "products",
    label: "Products",
    modules: [
      { key: "products.dashboard", label: "Products Dashboard", group: "products", aliases: ["dashboard"], scope: { table: "products" } },
      { key: "products.products", label: "Products", group: "products", aliases: ["product", "catalog", "inventory"], scope: { table: "products", addedBy: "created_by" }, extraActions: PRODUCT_EXTRA_ACTIONS },
    ],
  },
  {
    slug: "orders",
    label: "Orders",
    modules: [
      { key: "orders.dashboard", label: "Orders Dashboard", group: "orders", aliases: ["dashboard"], scope: { table: "orders" } },
      { key: "orders.orders", label: "Orders", group: "orders", aliases: ["order"], scope: { table: "orders", addedBy: "created_by", ownedBy: "assigned_to" } },
    ],
  },
  {
    slug: "legal",
    label: "Legal",
    modules: [
      { key: "legal.dashboard", label: "Legal Dashboard", group: "legal", aliases: ["dashboard"], scope: { table: "legal_contracts" } },
      { key: "legal.contracts", label: "Contracts", group: "legal", aliases: ["contract"], scope: { table: "legal_contracts", addedBy: "created_by" } },
      { key: "legal.esign", label: "Esign", group: "legal", aliases: ["esign", "sign", "signature"], scope: { table: "legal_esign_requests", addedBy: "created_by" } },
    ],
  },
  {
    slug: "marketing",
    label: "Marketing",
    modules: [
      { key: "marketing.dashboard", label: "Marketing Dashboard", group: "marketing", aliases: ["dashboard"], scope: { table: "social_posts" } },
      { key: "marketing.contacts", label: "Contacts", group: "marketing", aliases: ["contact"], scope: { table: "marketing_contacts" } },
      { key: "marketing.lead_generation", label: "Lead Generation", group: "marketing", aliases: ["lead_generation", "generation", "lead"], scope: { table: "marketing_leads" } },
      { key: "marketing.journeys", label: "Journeys", group: "marketing", aliases: ["journey"], scope: { table: "marketing_journeys" } },
      { key: "marketing.planner", label: "Marketing Planner", group: "marketing", aliases: ["planner", "plan"], scope: { table: "marketing_planner" } },
      // "social"/"email"/"whatsapp" aliases keep the legacy marketing.social.* feature slugs mapped here.
      { key: "marketing.campaigns", label: "Campaigns", group: "marketing", aliases: ["campaign", "social", "whatsapp"], scope: { table: "social_posts", addedBy: "created_by" } },
      { key: "marketing.website_analytics", label: "Website Analytics", group: "marketing", aliases: ["website_analytics", "analytics", "website"], scope: { table: "marketing_website_analytics" } },
      { key: "marketing.library", label: "Library", group: "marketing", aliases: ["library"], scope: { table: "marketing_library" } },
    ],
  },
  {
    slug: "calendar",
    label: "My Calendar",
    modules: [
      // The calendar reads each employee's own Google Calendar per-user, so
      // record-level scoping doesn't apply — only view access is meaningful.
      { key: "calendar.calendar", label: "My Calendar", group: "calendar", aliases: ["calendar"], scope: { table: "calendar_events" } },
    ],
  },
  {
    slug: "events",
    label: "Events",
    modules: [
      // Drives the Events module RBAC. "events.view" grants read access to the
      // Events pages/APIs; any write level grants "events.manage" (create/edit,
      // participant management, QR generate/revoke). The public gate-scan page
      // needs no session and is intentionally not gated by this matrix.
      { key: "events.events", label: "Events", group: "events", aliases: ["event"], scope: { table: "hr_events", addedBy: "created_by" } },
    ],
  },
  {
    slug: "assets",
    label: "Assets & Subscriptions",
    modules: [
      // Employee Assets is an ASSIGNMENT layer over Finance → Fixed Assets (the
      // asset master / source of truth). The base Add/View/Update/Delete scopes
      // govern the assignment records; the extended actions separate the asset
      // lifecycle operations (assign/return/reassign/mark lost or damaged) and
      // export from a plain Update, so they can be granted / revoked on their own.
      {
        key: "assets.employee_assets",
        label: "Employee Assets",
        group: "assets",
        aliases: ["employee_asset", "employee_assets", "asset", "assignment"],
        scope: { table: "employee_asset_assignments", addedBy: "created_by" },
        extraActions: EMPLOYEE_ASSET_EXTRA_ACTIONS,
      },
      // Company Subscriptions — the SaaS / license / recurring-service register.
      // Vendors come from Finance → Customers/Vendors; seats reference HR
      // employees. Base scopes govern the subscription records; extended actions
      // separate seat allocation, renewals, cancel/suspend, documents and export.
      {
        key: "assets.company_subscriptions",
        label: "Company Subscriptions",
        group: "assets",
        aliases: ["subscription", "subscriptions", "company_subscription", "company_subscriptions", "saas", "license"],
        scope: { table: "company_subscriptions", addedBy: "created_by" },
        extraActions: COMPANY_SUBSCRIPTION_EXTRA_ACTIONS,
      },
    ],
  },
]

export const PERMISSION_MODULES: PermissionModule[] = PERMISSION_GROUPS.flatMap((g) => g.modules)

const MODULE_BY_KEY = new Map(PERMISSION_MODULES.map((m) => [m.key, m]))

export function getPermissionModule(key: string): PermissionModule | undefined {
  return MODULE_BY_KEY.get(key)
}

/** The extended actions declared for a module (empty when none). */
export function getModuleExtraActions(key: string): ExtendedAction[] {
  return MODULE_BY_KEY.get(key)?.extraActions ?? []
}

/** Look up a single extended action definition on a module. */
export function getExtendedAction(moduleKey: string, actionKey: string): ExtendedAction | undefined {
  return MODULE_BY_KEY.get(moduleKey)?.extraActions?.find((a) => a.key === actionKey)
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

  // Decide whether the slug is a WRITE action or a plain view/navigation slug.
  // Only an explicit set of write verbs counts as "update"; everything else
  // (including noun-first read pages like `gst_filing`, `tds_filing`,
  // `journal_entries`, `general_ledger`, `financial_reports`) is treated as
  // "view". Defaulting unknown verbs to "update" was the bug: it demanded a
  // write scope to even see those pages, so granting an employee "View" access
  // left the page hidden or behaving wrong.
  const writeVerbs = [
    "manage",
    "create",
    "add",
    "edit",
    "update",
    "delete",
    "remove",
    "send",
    "schedule",
    "assign",
    "approve",
    "reject",
    "import",
    "upload",
    "revoke",
  ]
  const verb = rest.split("_")[0]
  const action: PermissionAction = writeVerbs.includes(verb) ? "update" : "view"

  const groupModules = PERMISSION_MODULES.filter((m) => m.group === group)
  if (groupModules.length === 0) return null

  const haystack = rest.replace(/^[a-z]+_/, "")
  const match =
    groupModules.find((m) => m.aliases.some((a) => haystack.includes(a) || rest.includes(a))) ??
    groupModules[0]

  return { moduleKey: match.key, action }
}
