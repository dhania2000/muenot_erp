/**
 * Custom Report Builder — data-source catalog (pure metadata).
 * ---------------------------------------------------------------------------
 * The allowlist of what a report can be built against. Mirrors the posture of
 * lib/data-export-catalog.ts: each SOURCE binds a stable key to a MODULE +
 * ENTITY (used to redact classified fields), a physical TABLE, the candidate
 * tenant/order columns, and — unique to reporting — a curated set of
 * whitelisted COLUMNS with their type metadata.
 *
 * Nothing here is trusted from the client. A report definition may only
 * reference a source key and column keys that appear in this catalog, and the
 * physical table / tenant columns / column presence are always re-resolved
 * against the LIVE schema on the server before a query is ever built. Columns a
 * deployment does not actually have are dropped, exactly like the export
 * catalog, so this file can advertise a superset safely.
 *
 * No `server-only` / DB import: this is shared, testable metadata. Only the
 * PUBLIC projection (see reportCatalogForClient in the API) is ever sent to the
 * browser — physical table and tenant-column names never leave the server.
 */

import type { DataDomain } from "@/lib/data-scope-model"

/** Logical type of a column — drives the operators and aggregations offered. */
export type ReportColumnType = "string" | "number" | "date" | "datetime" | "boolean"

export type ReportColumnDef = {
  /** Physical column name; also the logical key used everywhere. */
  key: string
  /** Human label shown in the builder. */
  label: string
  type: ReportColumnType
}

export type ReportSource = {
  /** Stable identifier used by the API and saved reports. */
  key: string
  /** Human module grouping (matches classification `module`). */
  module: string
  /** Classification entity — drives field redaction. */
  entity: string
  /** UI label. */
  label: string
  /** One-line description. */
  description: string
  /** Physical table (server-only; never projected to the client). */
  table: string
  /** Tenant-scoping column candidates; first that exists in the live schema wins. */
  tenantColumns: string[]
  /** Default column used for date-range filtering, when present. */
  defaultDateColumn?: string
  /** Permission feature slug that best describes this data (informational gate). */
  requiredFeature: string
  /** Whitelisted, typed columns. Unknown-at-runtime columns are dropped. */
  columns: ReportColumnDef[]
  /**
   * SPEC 99 — row access control. The data-scope domain whose per-user grant
   * governs row visibility for this report (user/team/entity/branch). When
   * absent, the report carries no relational row scope (tenant + field-level
   * protection still apply). Column lists below are CANDIDATES; only the ones
   * present in the live schema are ever referenced, so a missing column fails
   * the relational scope CLOSED rather than leaking rows.
   */
  scopeDomainKey?: string
  /** Candidate columns identifying the owning / assigned user (self / team). */
  ownerColumns?: string[]
  /** Candidate columns identifying the legal entity (entity scope). */
  scopeEntityColumns?: string[]
  /** Candidate columns identifying the branch (branch scope). */
  scopeBranchColumns?: string[]
}

const col = (key: string, label: string, type: ReportColumnType): ReportColumnDef => ({ key, label, type })

/**
 * The curated source registry. Tables mirror the vetted set used by the export
 * / retention catalogs so we only reference tables known to exist in real
 * deployments; unknown columns simply resolve away at run time.
 */
export const REPORT_SOURCES: ReportSource[] = [
  {
    key: "hr.employees",
    module: "HR",
    entity: "Employee",
    label: "Employees",
    description: "Employee master records — profile, employment and contact details.",
    table: "employees",
    tenantColumns: ["tenant_id", "company_id"],
    defaultDateColumn: "date_of_joining",
    requiredFeature: "hr.view_employees",
    scopeDomainKey: "hr.employees",
    ownerColumns: ["user_id", "created_by"],
    scopeEntityColumns: ["entity", "legal_entity", "entity_id", "legal_entity_id"],
    scopeBranchColumns: ["branch", "branch_name", "branch_id", "work_location"],
    columns: [
      col("id", "ID", "number"),
      col("employee_code", "Employee code", "string"),
      col("first_name", "First name", "string"),
      col("last_name", "Last name", "string"),
      col("email", "Email", "string"),
      col("phone", "Phone", "string"),
      col("department", "Department", "string"),
      col("designation", "Designation", "string"),
      col("employment_type", "Employment type", "string"),
      col("status", "Status", "string"),
      col("gender", "Gender", "string"),
      col("date_of_joining", "Date of joining", "date"),
      col("date_of_birth", "Date of birth", "date"),
      col("created_at", "Created at", "datetime"),
    ],
  },
  {
    key: "hr.attendance",
    module: "HR",
    entity: "Attendance",
    label: "Attendance",
    description: "Daily attendance and punch records.",
    table: "hr_attendance",
    tenantColumns: ["tenant_id", "company_id"],
    defaultDateColumn: "date",
    requiredFeature: "hr.view_attendance",
    columns: [
      col("id", "ID", "number"),
      col("employee_id", "Employee ID", "number"),
      col("date", "Date", "date"),
      col("status", "Status", "string"),
      col("check_in", "Check in", "datetime"),
      col("check_out", "Check out", "datetime"),
      col("work_hours", "Work hours", "number"),
      col("overtime_hours", "Overtime hours", "number"),
      col("created_at", "Created at", "datetime"),
    ],
  },
  {
    key: "finance.invoices",
    module: "Finance",
    entity: "SalesInvoice",
    label: "Sales invoices",
    description: "Sales invoices with totals, status and customer reference.",
    table: "sales_invoices",
    tenantColumns: ["tenant_id", "company_id"],
    defaultDateColumn: "issue_date",
    requiredFeature: "finance.view_sales_invoices",
    columns: [
      col("id", "ID", "number"),
      col("invoice_number", "Invoice number", "string"),
      col("client_id", "Client ID", "number"),
      col("status", "Status", "string"),
      col("currency", "Currency", "string"),
      col("subtotal", "Subtotal", "number"),
      col("tax_amount", "Tax amount", "number"),
      col("total", "Total", "number"),
      col("amount_paid", "Amount paid", "number"),
      col("issue_date", "Issue date", "date"),
      col("due_date", "Due date", "date"),
      col("created_at", "Created at", "datetime"),
    ],
  },
  {
    key: "finance.expenses",
    module: "Finance",
    entity: "Expense",
    label: "Expenses",
    description: "Recorded expenses and reimbursements.",
    table: "finance_expenses",
    tenantColumns: ["tenant_id", "company_id"],
    defaultDateColumn: "expense_date",
    requiredFeature: "finance.view_expenses",
    columns: [
      col("id", "ID", "number"),
      col("reference", "Reference", "string"),
      col("category", "Category", "string"),
      col("vendor", "Vendor", "string"),
      col("status", "Status", "string"),
      col("amount", "Amount", "number"),
      col("tax_amount", "Tax amount", "number"),
      col("currency", "Currency", "string"),
      col("expense_date", "Expense date", "date"),
      col("created_at", "Created at", "datetime"),
    ],
  },
  {
    key: "sales.leads",
    module: "Sales",
    entity: "Lead",
    label: "Leads",
    description: "Sales leads and their pipeline stage.",
    table: "leads",
    tenantColumns: ["tenant_id", "company_id"],
    defaultDateColumn: "created_at",
    requiredFeature: "sales.view_leads",
    scopeDomainKey: "sales.leads",
    ownerColumns: ["assigned_to", "created_by", "owner", "owner_id"],
    scopeEntityColumns: ["entity", "entity_id", "legal_entity_id"],
    scopeBranchColumns: ["branch", "branch_id"],
    columns: [
      col("id", "ID", "number"),
      col("name", "Name", "string"),
      col("company", "Company", "string"),
      col("email", "Email", "string"),
      col("phone", "Phone", "string"),
      col("source", "Source", "string"),
      col("status", "Status", "string"),
      col("stage", "Stage", "string"),
      col("estimated_value", "Estimated value", "number"),
      col("owner", "Owner", "string"),
      col("created_at", "Created at", "datetime"),
    ],
  },
  {
    key: "crm.clients",
    module: "CRM",
    entity: "Client",
    label: "Clients",
    description: "Client / customer accounts.",
    table: "clients",
    tenantColumns: ["tenant_id", "company_id"],
    defaultDateColumn: "created_at",
    requiredFeature: "clients.view_clients",
    columns: [
      col("id", "ID", "number"),
      col("name", "Name", "string"),
      col("client_type", "Client type", "string"),
      col("email", "Email", "string"),
      col("phone", "Phone", "string"),
      col("city", "City", "string"),
      col("country", "Country", "string"),
      col("status", "Status", "string"),
      col("created_at", "Created at", "datetime"),
    ],
  },
  {
    key: "operations.projects",
    module: "Operations",
    entity: "Project",
    label: "Projects",
    description: "Operational projects and their status.",
    table: "operations_projects",
    tenantColumns: ["tenant_id", "company_id"],
    defaultDateColumn: "start_date",
    requiredFeature: "operations.view_projects",
    columns: [
      col("id", "ID", "number"),
      col("name", "Name", "string"),
      col("code", "Code", "string"),
      col("status", "Status", "string"),
      col("priority", "Priority", "string"),
      col("budget", "Budget", "number"),
      col("start_date", "Start date", "date"),
      col("end_date", "End date", "date"),
      col("created_at", "Created at", "datetime"),
    ],
  },
  {
    key: "recruitment.candidates",
    module: "Recruitment",
    entity: "Candidate",
    label: "Candidates",
    description: "Recruitment candidates and application state.",
    table: "recruit_candidates",
    tenantColumns: ["tenant_id", "company_id"],
    defaultDateColumn: "created_at",
    requiredFeature: "recruitment.view_candidates",
    columns: [
      col("id", "ID", "number"),
      col("name", "Name", "string"),
      col("email", "Email", "string"),
      col("phone", "Phone", "string"),
      col("source", "Source", "string"),
      col("stage", "Stage", "string"),
      col("status", "Status", "string"),
      col("created_at", "Created at", "datetime"),
    ],
  },
]

export function getReportSource(key: string): ReportSource | undefined {
  return REPORT_SOURCES.find((s) => s.key === key)
}

/**
 * SPEC 99 — project a source's row-scope metadata into the pure `DataDomain`
 * shape the data-scope engine consumes. Returns `null` when the source has no
 * linked scope domain (no relational row restriction). Kept here (pure, no DB)
 * so the report row-access rules are unit-testable without a database.
 */
export function reportScopeDomain(source: ReportSource): DataDomain | null {
  if (!source.scopeDomainKey) return null
  return {
    key: source.scopeDomainKey,
    label: source.label,
    table: source.table,
    ownerColumns: source.ownerColumns ?? [],
    entityColumns: source.scopeEntityColumns ?? [],
    branchColumns: source.scopeBranchColumns ?? [],
  }
}

/** Public projection of a column — safe for the browser. */
export type PublicReportColumn = ReportColumnDef

/** Public projection of a source — no physical table / tenant-column names. */
export type PublicReportSource = {
  key: string
  module: string
  entity: string
  label: string
  description: string
  requiredFeature: string
  defaultDateColumn: string | null
  columns: PublicReportColumn[]
}
