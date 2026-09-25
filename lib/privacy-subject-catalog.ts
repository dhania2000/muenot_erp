/**
 * Spec24 — Personal-data location catalog (pure metadata).
 * ---------------------------------------------------------------------------
 * The registry of WHERE a data subject's personal data lives across the ERP.
 * Each entry binds a stable KEY to a physical TABLE plus:
 *   - the candidate columns that identify a subject (email / name), used to
 *     find that person's rows,
 *   - the tenant-scoping column candidates (so a lookup never crosses tenants),
 *   - the PII columns to redact when anonymizing (keep the row, scrub identity),
 *   - the retention catalog key this table maps to, so a DSAR can consult the
 *     SAME retention obligations the retention engine enforces,
 *   - a legal-hold `module` label so a DSAR consults the SAME legal holds the
 *     retention engine and storage sweep consult.
 *
 * Physical table/column names never leave the server: the admin API projects
 * only the public metadata. The store resolves the real columns against the
 * LIVE schema at run time and skips gracefully when a table or column is absent
 * — the same defensive posture as lib/retention-catalog.ts and
 * lib/data-export-catalog.ts, which this deliberately mirrors and reuses.
 *
 * No `server-only`/DB import: shared, testable metadata.
 */

export type SubjectDataLocation = {
  /** Stable identifier used by the API and request records, e.g. "hr.employees". */
  key: string
  /** Business module label (matches classification/legal-hold `module`). */
  module: string
  /** Human-facing label for the UI / audit evidence. */
  label: string
  /** Physical table (server-only; never projected to the client). */
  table: string
  /** Columns that identify the subject; a row matches if ANY equals the subject email. */
  emailColumns: string[]
  /** Tenant-scoping column candidates; first that exists in the live schema wins. */
  tenantColumns: string[]
  /**
   * PII columns to overwrite when anonymizing. When empty, the location cannot
   * be anonymized (only erased or retained-as-is).
   */
  piiColumns: string[]
  /**
   * The retention-catalog key governing this table, if any. A DSAR erase looks
   * up whether an ACTIVE retention policy on this key forbids deleting the row
   * (in which case it downgrades to anonymize).
   */
  retentionKey: string | null
  /** Whether erasure (row delete) is ever permitted for this location. */
  erasable: boolean
}

/**
 * The curated personal-data registry. Tables mirror the vetted set used by the
 * retention and export catalogs so we only reference columns known to exist in
 * real deployments; unknown tables simply resolve to "no data" at run time.
 */
export const SUBJECT_DATA_CATALOG: readonly SubjectDataLocation[] = [
  // -- HR ------------------------------------------------------------------
  {
    key: "hr.employees",
    module: "HR",
    label: "Employee record",
    table: "employees",
    emailColumns: ["email", "work_email", "personal_email"],
    tenantColumns: ["tenant_id", "company_id"],
    piiColumns: ["name", "full_name", "phone", "personal_email", "address", "date_of_birth", "emergency_contact"],
    retentionKey: "hr.offboarding",
    erasable: false,
  },
  // -- Recruitment ---------------------------------------------------------
  {
    key: "recruitment.candidates",
    module: "Recruitment",
    label: "Recruitment candidate",
    table: "recruit_candidates",
    emailColumns: ["email", "candidate_email"],
    tenantColumns: ["tenant_id", "company_id"],
    piiColumns: ["name", "full_name", "phone", "address", "resume_url", "linkedin_url"],
    retentionKey: "recruitment.candidates",
    erasable: true,
  },
  // -- Marketing -----------------------------------------------------------
  {
    key: "marketing.contacts",
    module: "Marketing",
    label: "Marketing contact",
    table: "marketing_contacts",
    emailColumns: ["email"],
    tenantColumns: ["tenant_id", "company_id"],
    piiColumns: ["name", "first_name", "last_name", "phone", "company"],
    retentionKey: null,
    erasable: true,
  },
  // -- CRM -----------------------------------------------------------------
  {
    key: "crm.leads",
    module: "CRM",
    label: "CRM lead",
    table: "leads",
    emailColumns: ["email", "contact_email"],
    tenantColumns: ["tenant_id", "company_id"],
    piiColumns: ["name", "contact_name", "phone", "mobile"],
    retentionKey: "crm.lost_leads",
    erasable: true,
  },
  {
    key: "crm.clients",
    module: "CRM",
    label: "Client contact",
    table: "clients",
    emailColumns: ["email", "primary_email", "contact_email"],
    tenantColumns: ["tenant_id", "company_id"],
    piiColumns: ["contact_name", "phone", "billing_address"],
    retentionKey: "sales.clients",
    erasable: false,
  },
] as const

const BY_KEY = new Map(SUBJECT_DATA_CATALOG.map((e) => [e.key, e]))

export function getSubjectLocation(key: string | null | undefined): SubjectDataLocation | null {
  if (!key) return null
  return BY_KEY.get(key) ?? null
}

/** A location can only be anonymized if the catalog lists PII columns for it. */
export function isAnonymizable(entry: SubjectDataLocation): boolean {
  return entry.piiColumns.length > 0
}

/** Public projection — safe to send to the browser (no physical schema names). */
export type PublicSubjectLocation = {
  key: string
  module: string
  label: string
  erasable: boolean
  anonymizable: boolean
  retentionKey: string | null
}

export function subjectCatalogForClient(): PublicSubjectLocation[] {
  return SUBJECT_DATA_CATALOG.map((e) => ({
    key: e.key,
    module: e.module,
    label: e.label,
    erasable: e.erasable,
    anonymizable: isAnonymizable(e),
    retentionKey: e.retentionKey,
  }))
}

/**
 * Resolve the first candidate column that actually exists in the live table.
 * `existing` is the set of real column names (lower-cased) from schema
 * introspection. Returns null when no candidate is present.
 */
export function resolveExistingColumn(candidates: string[], existing: Set<string>): string | null {
  for (const c of candidates) {
    if (existing.has(c.toLowerCase())) return c
  }
  return null
}

/** All identifier columns that exist in the live table (a subject may appear under any). */
export function resolveExistingColumns(candidates: string[], existing: Set<string>): string[] {
  return candidates.filter((c) => existing.has(c.toLowerCase()))
}
