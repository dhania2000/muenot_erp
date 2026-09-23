/**
 * Tenant Data Export catalog (pure metadata).
 * ---------------------------------------------------------------------------
 * The registry of what a tenant admin may export. Each dataset binds a stable
 * export KEY to a MODULE + ENTITY (the classification coordinates used
 * to redact sensitive fields) and a physical TABLE plus the candidate columns
 * used to scope the query to a single tenant and order it deterministically.
 *
 * Physical table/column names never leave the server: the admin API projects
 * only the public metadata (key/module/entity/label/description/pdfEligible).
 * The store resolves the real table + tenant column against the LIVE schema at
 * run time, skipping gracefully when a table is absent in a given deployment —
 * the same defensive posture as lib/retention-catalog.ts.
 *
 * No `server-only`/DB import: this is shared, testable metadata.
 */

export type ExportDataset = {
  /** Stable identifier used by the API and job records. */
  key: string
  /** Human module grouping (matches classification `module`). */
  module: string
  /** Classification entity — drives export redaction. */
  entity: string
  /** UI label. */
  label: string
  /** One-line description of what the dataset contains. */
  description: string
  /** Physical table (server-only; never projected to the client). */
  table: string
  /** Tenant-scoping column candidates, first that exists in the live schema wins. */
  tenantColumns: string[]
  /** Ordering column candidates for a deterministic export. */
  orderColumns: string[]
  /** Whether a PDF rendering is meaningful for this dataset. */
  pdfEligible: boolean
}

/**
 * The curated dataset registry. Tables mirror the vetted set used by the
 * retention catalog so we only reference columns known to exist in real
 * deployments; unknown tables simply resolve to "no data" at run time.
 */
export const EXPORT_CATALOG: ExportDataset[] = [
  {
    key: "hr.employees",
    module: "HR",
    entity: "Employee",
    label: "Employees",
    description: "Employee master records — profile, employment and contact details.",
    table: "employees",
    tenantColumns: ["tenant_id", "company_id"],
    orderColumns: ["id", "created_at"],
    pdfEligible: true,
  },
  {
    key: "hr.attendance",
    module: "HR",
    entity: "Attendance",
    label: "Attendance",
    description: "Daily attendance and punch records.",
    table: "hr_attendance",
    tenantColumns: ["tenant_id", "company_id"],
    orderColumns: ["date", "id"],
    pdfEligible: false,
  },
  {
    key: "finance.invoices",
    module: "Finance",
    entity: "SalesInvoice",
    label: "Invoices",
    description: "Sales invoices with totals, status and customer reference.",
    table: "sales_invoices",
    tenantColumns: ["tenant_id", "company_id"],
    orderColumns: ["issue_date", "id"],
    pdfEligible: true,
  },
  {
    key: "finance.expenses",
    module: "Finance",
    entity: "Expense",
    label: "Expenses",
    description: "Recorded expenses and reimbursements.",
    table: "finance_expenses",
    tenantColumns: ["tenant_id", "company_id"],
    orderColumns: ["expense_date", "id"],
    pdfEligible: true,
  },
  {
    key: "finance.journal",
    module: "Finance",
    entity: "JournalEntry",
    label: "Journal entries",
    description: "General-ledger journal entries.",
    table: "finance_journal_entries",
    tenantColumns: ["tenant_id", "company_id"],
    orderColumns: ["entry_date", "id"],
    pdfEligible: false,
  },
  {
    key: "sales.leads",
    module: "Sales",
    entity: "Lead",
    label: "Leads",
    description: "Sales leads and their pipeline stage.",
    table: "leads",
    tenantColumns: ["tenant_id", "company_id"],
    orderColumns: ["created_at", "id"],
    pdfEligible: false,
  },
  {
    key: "crm.clients",
    module: "CRM",
    entity: "Client",
    label: "Clients",
    description: "Client / customer accounts.",
    table: "clients",
    tenantColumns: ["tenant_id", "company_id"],
    orderColumns: ["created_at", "id"],
    pdfEligible: true,
  },
  {
    key: "operations.projects",
    module: "Operations",
    entity: "Project",
    label: "Projects",
    description: "Operational projects and their status.",
    table: "operations_projects",
    tenantColumns: ["tenant_id", "company_id"],
    orderColumns: ["created_at", "id"],
    pdfEligible: false,
  },
  {
    key: "recruitment.candidates",
    module: "Recruitment",
    entity: "Candidate",
    label: "Candidates",
    description: "Recruitment candidates and application state.",
    table: "recruit_candidates",
    tenantColumns: ["tenant_id", "company_id"],
    orderColumns: ["created_at", "id"],
    pdfEligible: false,
  },
]

export function getExportDataset(key: string): ExportDataset | undefined {
  return EXPORT_CATALOG.find((d) => d.key === key)
}

/** Public projection — safe to send to the browser (no physical schema names). */
export type PublicExportDataset = {
  key: string
  module: string
  entity: string
  label: string
  description: string
  pdfEligible: boolean
}

export function exportCatalogForClient(): PublicExportDataset[] {
  return EXPORT_CATALOG.map((d) => ({
    key: d.key,
    module: d.module,
    entity: d.entity,
    label: d.label,
    description: d.description,
    pdfEligible: d.pdfEligible,
  }))
}

/**
 * Resolve the first tenant/order column that actually exists in the live table.
 * `existing` is the set of real column names (lower-cased) from schema
 * introspection. Returns null when no candidate is present.
 */
export function resolveExistingColumn(candidates: string[], existing: Set<string>): string | null {
  for (const c of candidates) {
    if (existing.has(c.toLowerCase())) return c
  }
  return null
}
