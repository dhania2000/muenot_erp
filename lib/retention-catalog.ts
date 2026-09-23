/**
 * Retention module catalog (Phase 3: module integration).
 * ---------------------------------------------------------------------------
 * The generalized engine acts on ANY ERP record type. This catalog is the
 * curated bridge between a business "record type" and the physical table the
 * lifecycle job reads and (when configured) archives/purges.
 *
 * It is deliberately install-agnostic: each entry lists CANDIDATE column names
 * for the primary key, the tenant discriminator and the "age" date. The engine
 * (lib/retention-engine.ts) resolves the actual columns at run time against
 * information_schema and skips gracefully when a table or required column does
 * not exist on a given install — so an accurate catalog never breaks a tenant
 * whose schema differs, and new modules can be added here without a migration.
 *
 * Pure data + resolution helpers only (no DB / server-only import) so it can be
 * surfaced to the settings UI via the API and unit-tested directly.
 */

export type RetentionCatalogEntry = {
  /** Stable identifier stored on a policy, e.g. "finance.sales_invoices". */
  key: string
  /** Business module label (HR, Finance, CRM, …). */
  module: string
  /** Human-facing record-type label. */
  recordType: string
  /** Short description for the settings UI. */
  description: string
  /** Physical table the lifecycle job reads. */
  table: string
  /** Entity name used for data-classification retention lookups (module/entity). */
  entity: string
  /** Ordered candidate primary-key columns; first that exists is used. */
  primaryKeyCandidates: string[]
  /** Ordered candidate tenant discriminator columns; first that exists is used. */
  tenantColumnCandidates: string[]
  /** Ordered candidate "age" date columns; first that exists is used. */
  dateColumnCandidates: string[]
  /** Whether the destructive Delete action may be selected for this record type. */
  allowDelete: boolean
  /** Suggested retention window in days (a sensible statutory-ish default). */
  suggestedDays: number
  /**
   * Optional status gate — only records whose `column` equals one of `equals`
   * are eligible (e.g. only Paid/Closed invoices). Applied only when `column`
   * actually exists on the install; otherwise ignored.
   */
  statusFilter?: { column: string; equals: string[] }
}

const YEAR = 365

/**
 * The starter catalog. Covers the common statutory-retention record types
 * across the ERP's core modules. Additional record types are added by
 * appending here — no schema change required.
 */
export const RETENTION_CATALOG: readonly RetentionCatalogEntry[] = [
  // -- Finance -------------------------------------------------------------
  {
    key: "finance.sales_invoices",
    module: "Finance",
    recordType: "Closed sales invoices",
    description: "Paid or cancelled customer invoices past their statutory keep period.",
    table: "sales_invoices",
    entity: "SalesInvoice",
    primaryKeyCandidates: ["id"],
    tenantColumnCandidates: ["tenant_id"],
    dateColumnCandidates: ["invoice_date", "updated_at", "created_at"],
    allowDelete: false,
    suggestedDays: 10 * YEAR,
    statusFilter: { column: "status", equals: ["Paid", "Cancelled", "Closed", "Void"] },
  },
  {
    key: "finance.expenses",
    module: "Finance",
    recordType: "Settled expenses",
    description: "Reimbursed / posted expense records past their keep period.",
    table: "finance_expenses",
    entity: "Expense",
    primaryKeyCandidates: ["id"],
    tenantColumnCandidates: ["tenant_id"],
    dateColumnCandidates: ["expense_date", "updated_at", "created_at"],
    allowDelete: false,
    suggestedDays: 8 * YEAR,
  },
  {
    key: "finance.journal_entries",
    module: "Finance",
    recordType: "Journal entries",
    description: "General-ledger journal entries past their statutory keep period.",
    table: "finance_journal_entries",
    entity: "JournalEntry",
    primaryKeyCandidates: ["id"],
    tenantColumnCandidates: ["tenant_id"],
    dateColumnCandidates: ["entry_date", "posting_date", "created_at"],
    allowDelete: false,
    suggestedDays: 10 * YEAR,
  },
  // -- HR ------------------------------------------------------------------
  {
    key: "hr.offboarding",
    module: "HR",
    recordType: "Terminated employee offboarding",
    description: "Completed offboarding cases for employees who have left the company.",
    table: "hr_offboarding",
    entity: "Offboarding",
    primaryKeyCandidates: ["id"],
    tenantColumnCandidates: ["tenant_id"],
    dateColumnCandidates: ["last_working_day", "completed_at", "updated_at", "created_at"],
    allowDelete: false,
    suggestedDays: 7 * YEAR,
  },
  {
    key: "hr.attendance",
    module: "HR",
    recordType: "Attendance records",
    description: "Daily attendance punches past their keep period.",
    table: "hr_attendance",
    entity: "Attendance",
    primaryKeyCandidates: ["id"],
    tenantColumnCandidates: ["tenant_id"],
    dateColumnCandidates: ["attendance_date", "work_date", "created_at"],
    allowDelete: true,
    suggestedDays: 3 * YEAR,
  },
  // -- CRM / Sales ---------------------------------------------------------
  {
    key: "crm.lost_leads",
    module: "CRM",
    recordType: "Lost / dead leads",
    description: "Leads that were lost or marked dead and are no longer actionable.",
    table: "leads",
    entity: "Lead",
    primaryKeyCandidates: ["id"],
    tenantColumnCandidates: ["tenant_id"],
    dateColumnCandidates: ["updated_at", "created_at"],
    allowDelete: true,
    suggestedDays: 2 * YEAR,
    statusFilter: { column: "status", equals: ["Lost", "Dead", "Junk", "Disqualified"] },
  },
  {
    key: "sales.clients",
    module: "Sales",
    recordType: "Inactive clients",
    description: "Client records with no recent activity past their keep period.",
    table: "clients",
    entity: "Client",
    primaryKeyCandidates: ["id"],
    tenantColumnCandidates: ["tenant_id"],
    dateColumnCandidates: ["updated_at", "created_at"],
    allowDelete: false,
    suggestedDays: 5 * YEAR,
  },
  // -- Operations ----------------------------------------------------------
  {
    key: "operations.projects",
    module: "Operations",
    recordType: "Completed projects",
    description: "Closed / completed projects and their metadata past the keep period.",
    table: "operations_projects",
    entity: "Project",
    primaryKeyCandidates: ["id"],
    tenantColumnCandidates: ["tenant_id"],
    dateColumnCandidates: ["end_date", "closed_at", "updated_at", "created_at"],
    allowDelete: false,
    suggestedDays: 5 * YEAR,
    statusFilter: { column: "status", equals: ["Completed", "Closed", "Archived"] },
  },
  // -- Recruitment ---------------------------------------------------------
  {
    key: "recruitment.candidates",
    module: "Recruitment",
    recordType: "Rejected candidates",
    description: "Candidate records for rejected / withdrawn applicants (GDPR keep window).",
    table: "recruit_candidates",
    entity: "Candidate",
    primaryKeyCandidates: ["id"],
    tenantColumnCandidates: ["tenant_id"],
    dateColumnCandidates: ["updated_at", "created_at"],
    allowDelete: true,
    suggestedDays: 2 * YEAR,
  },
] as const

const BY_KEY = new Map(RETENTION_CATALOG.map((e) => [e.key, e]))

export function getCatalogEntry(key: string | null | undefined): RetentionCatalogEntry | null {
  if (!key) return null
  return BY_KEY.get(key) ?? null
}

/** Distinct module labels present in the catalog, in first-seen order. */
export function catalogModules(): string[] {
  const seen: string[] = []
  for (const e of RETENTION_CATALOG) if (!seen.includes(e.module)) seen.push(e.module)
  return seen
}

/**
 * Resolve a catalog entry's candidate columns against the set of columns that
 * actually exist on this install. Returns the concrete columns to use, or a
 * reason string when the record type is not executable here.
 */
export type ResolvedTarget = {
  table: string
  entity: string
  primaryKey: string
  tenantColumn: string
  dateColumn: string
  statusFilter: { column: string; equals: string[] } | null
}

export function resolveTargetColumns(
  entry: RetentionCatalogEntry,
  existingColumns: Set<string>,
): { ok: true; target: ResolvedTarget } | { ok: false; reason: string } {
  if (existingColumns.size === 0) {
    return { ok: false, reason: `Table \`${entry.table}\` does not exist on this install` }
  }
  const pick = (candidates: string[]) => candidates.find((c) => existingColumns.has(c)) ?? null
  const primaryKey = pick(entry.primaryKeyCandidates)
  const tenantColumn = pick(entry.tenantColumnCandidates)
  const dateColumn = pick(entry.dateColumnCandidates)
  if (!primaryKey) return { ok: false, reason: `No primary-key column found on \`${entry.table}\`` }
  if (!tenantColumn) return { ok: false, reason: `\`${entry.table}\` is not tenant-scoped (no tenant column)` }
  if (!dateColumn) return { ok: false, reason: `No age/date column found on \`${entry.table}\`` }
  const statusFilter =
    entry.statusFilter && existingColumns.has(entry.statusFilter.column) ? entry.statusFilter : null
  return { ok: true, target: { table: entry.table, entity: entry.entity, primaryKey, tenantColumn, dateColumn, statusFilter } }
}
