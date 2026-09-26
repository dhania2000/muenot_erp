/**
 * Spec39 (#223-226) — Customer / Vendor / Employee 360 model.
 * ---------------------------------------------------------------------------
 * Pure, side-effect-free definitions shared by the store, API and tests:
 *   - which anchor table each 360 kind reads, and the base permission
 *   - the cross-module section catalogue (CRM, finance, contracts, tickets,
 *     assets, documents, activity) and how each joins the anchor by STABLE id
 *   - per-field masking of sensitive profile data
 *   - duplicate-identity normalisation
 *
 * Candidate 360 is intentionally NOT modelled here: it keeps its own
 * recruitment-owned implementation (lib/recruit-unification-db.ts). Employee
 * 360 links to it via recruit applications, it does not replace it.
 */
import { maskValue, type SensitiveCategory } from "@/lib/field-security-model"

export const PARTY_KINDS = ["customer", "vendor", "employee"] as const
export type PartyKind = (typeof PARTY_KINDS)[number]

export function parsePartyKind(value: unknown): PartyKind | null {
  return PARTY_KINDS.includes(value as PartyKind) ? (value as PartyKind) : null
}

/** Positive 32-bit integer ids only — rejects "1e3", "01x", negatives, floats. */
export function parsePartyId(value: unknown): number | null {
  const s = String(value ?? "")
  if (!/^[1-9]\d{0,9}$/.test(s)) return null
  const n = Number(s)
  return n <= 2_147_483_647 ? n : null
}

/** Search text: trimmed, bounded, no control characters. Empty → null. */
export function parseSearchQuery(value: unknown): string | null {
  if (typeof value !== "string") return null
  const s = value.replace(/[\u0000-\u001f\u007f]/g, "").trim()
  if (!s) return null
  return s.slice(0, 100)
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

export type AnchorSpec = {
  table: string
  label: string
  /** Base feature required to open any record of this kind. */
  viewFeature: string
  /** Column holding the display name. */
  nameColumn: string
  /** Column holding the human business code, if any. */
  codeColumn: string
  /** Profile columns selected (only those that exist are read). */
  profileColumns: string[]
  /** Extra static WHERE filter on the anchor (e.g. vendors only). */
  anchorFilter?: { sql: string; params: unknown[]; requiresColumn: string }
  /** Normalised identity keys used for duplicate detection. */
  identityColumns: { column: string; kind: IdentityKind }[]
  /** Drill-down to the owning module's record. */
  recordHref: (id: number) => string
  pageHref: string
  /** field-security module/entity used for tenant-configured policies. */
  fieldSecurity: { module: string; entity: string }
}

export const ANCHORS: Record<PartyKind, AnchorSpec> = {
  customer: {
    table: "sales_companies",
    label: "Customer",
    viewFeature: "sales.view_companies",
    nameColumn: "company_name",
    codeColumn: "company_code",
    profileColumns: [
      "id", "company_code", "company_name", "industry", "website", "company_email", "country",
      "assigned_to", "company_type", "status", "priority", "employee_count", "last_contact_date", "created_at",
    ],
    identityColumns: [
      { column: "company_email", kind: "email" },
      { column: "website", kind: "domain" },
      { column: "company_name", kind: "name" },
    ],
    recordHref: (id) => `/modules/sales/companies?company=${id}`,
    pageHref: "/modules/sales/customer-360",
    fieldSecurity: { module: "sales", entity: "companies" },
  },
  vendor: {
    table: "customers_vendors",
    label: "Vendor",
    viewFeature: "finance.view_customers_vendors",
    nameColumn: "customer_name",
    codeColumn: "party_id",
    profileColumns: [
      "id", "party_id", "customer_name", "legal_name", "party_type", "party_category", "gstin", "pan", "tan",
      "contact_person", "official_email", "mobile", "city", "state", "country", "payment_terms_days",
      "credit_limit", "currency", "bank_name", "bank_account_no", "ifsc", "tds_section", "tds_rate", "status",
      "created_at",
    ],
    anchorFilter: {
      sql: "party_type IN ('Vendor','Both','vendor','both')",
      params: [],
      requiresColumn: "party_type",
    },
    identityColumns: [
      { column: "gstin", kind: "tax_id" },
      { column: "pan", kind: "tax_id" },
      { column: "official_email", kind: "email" },
    ],
    recordHref: (id) => `/modules/finance/customers-vendors?party=${id}`,
    pageHref: "/modules/finance/vendor-360",
    fieldSecurity: { module: "finance", entity: "customers_vendors" },
  },
  employee: {
    table: "hr_employees",
    label: "Employee",
    viewFeature: "hr.view_employees",
    nameColumn: "employee_name",
    codeColumn: "employee_id",
    profileColumns: [
      "id", "employee_id", "employee_name", "gender", "designation", "department", "joining_date",
      "employment_status", "document_status", "reporting_manager", "personal_email", "mobile", "address",
      "emergency_contact_name", "bank_name", "bank_account_number", "bank_ifsc_code", "bank_pan_number", "user_id",
    ],
    identityColumns: [
      { column: "personal_email", kind: "email" },
      { column: "mobile", kind: "phone" },
      { column: "bank_pan_number", kind: "tax_id" },
    ],
    recordHref: (id) => `/modules/hr/employees?employee=${id}`,
    pageHref: "/modules/hr/employee-360",
    fieldSecurity: { module: "hr", entity: "employees" },
  },
}

// ---------------------------------------------------------------------------
// Per-field masking
// ---------------------------------------------------------------------------

export type FieldMask = { category: SensitiveCategory; revealFeature: string }

/**
 * Baseline masks. A field is shown in clear only when the viewer holds the
 * reveal feature (or is an admin). Tenant field-security policies are applied
 * on top by the store and can only restrict further.
 */
export const FIELD_MASKS: Record<PartyKind, Record<string, FieldMask>> = {
  customer: {
    company_email: { category: "personal_identifier", revealFeature: "sales.view_leads" },
  },
  vendor: {
    gstin: { category: "tax", revealFeature: "finance.manage_customers_vendors" },
    pan: { category: "pan", revealFeature: "finance.manage_customers_vendors" },
    tan: { category: "tax", revealFeature: "finance.manage_customers_vendors" },
    bank_account_no: { category: "bank_account", revealFeature: "finance.manage_customers_vendors" },
    ifsc: { category: "bank_account", revealFeature: "finance.manage_customers_vendors" },
    credit_limit: { category: "financial", revealFeature: "finance.manage_customers_vendors" },
    mobile: { category: "personal_identifier", revealFeature: "finance.manage_customers_vendors" },
  },
  employee: {
    personal_email: { category: "personal_identifier", revealFeature: "hr.manage_employees" },
    mobile: { category: "personal_identifier", revealFeature: "hr.manage_employees" },
    address: { category: "personal_identifier", revealFeature: "hr.manage_employees" },
    emergency_contact_name: { category: "personal_identifier", revealFeature: "hr.manage_employees" },
    bank_account_number: { category: "bank_account", revealFeature: "hr.manage_employees" },
    bank_ifsc_code: { category: "bank_account", revealFeature: "hr.manage_employees" },
    bank_pan_number: { category: "pan", revealFeature: "hr.manage_employees" },
  },
}

/** Fields never returned by the 360 at all (internal linkage only). */
const INTERNAL_FIELDS = new Set(["user_id"])

export function applyProfileMasks(
  kind: PartyKind,
  profile: Record<string, unknown>,
  canReveal: (feature: string) => boolean,
): { profile: Record<string, unknown>; masked: string[] } {
  const masks = FIELD_MASKS[kind]
  const out: Record<string, unknown> = {}
  const masked: string[] = []
  for (const [field, value] of Object.entries(profile)) {
    if (INTERNAL_FIELDS.has(field)) continue
    const rule = masks[field]
    if (rule && !canReveal(rule.revealFeature) && value != null && String(value).trim() !== "") {
      out[field] = maskValue(value, rule.category)
      masked.push(field)
    } else {
      out[field] = value
    }
  }
  return { profile: out, masked }
}

// ---------------------------------------------------------------------------
// Duplicate identities
// ---------------------------------------------------------------------------

export type IdentityKind = "email" | "phone" | "tax_id" | "domain" | "name"

export function normalizeIdentity(kind: IdentityKind, value: unknown): string | null {
  if (value == null) return null
  let s = String(value).trim()
  if (!s) return null
  switch (kind) {
    case "email":
      s = s.toLowerCase()
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null
    case "phone": {
      const digits = s.replace(/\D/g, "")
      return digits.length >= 7 ? digits.slice(-10) : null
    }
    case "tax_id": {
      const t = s.toUpperCase().replace(/[\s-]/g, "")
      return t.length >= 5 ? t : null
    }
    case "domain": {
      const d = s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0]
      return d.includes(".") ? d : null
    }
    case "name": {
      const n = s
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\b(pvt|private|ltd|limited|llp|inc|llc|co|corp|the)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim()
      return n.length >= 3 ? n : null
    }
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export type SectionGroup = "crm" | "finance" | "contracts" | "tickets" | "assets" | "documents" | "activity" | "hr" | "recruitment"

/**
 * A link joins a child table to the anchor. `from` names the anchor value:
 * "id" (anchor PK), "code" (business code), "name" (display name), or a
 * derived identity resolved by the store ("clientIds", "financePartyIds").
 * `stable` links are id-based; name links are only used when the child table
 * is itself tenant-scoped, otherwise the section fails closed.
 */
export type SectionLink = {
  column: string
  from: "id" | "code" | "name" | "clientIds" | "financePartyIds"
  stable: boolean
}

export type SectionSpec = {
  key: string
  label: string
  group: SectionGroup
  table: string
  /** Viewer needs ANY of these features to see the section. */
  features: string[]
  links: SectionLink[]
  /** Static equality filters; the section is "not_linked" if a column is missing. */
  where?: { column: string; values: string[] }[]
  titleColumns: string[]
  subtitleColumns?: string[]
  statusColumns?: string[]
  dateColumns?: string[]
  amountColumns?: string[]
  /** Drill-down for a row; `ref` is the row's business code or id. */
  rowHref: (row: { id: unknown; ref: unknown }) => string
  moduleHref: string
}

const ref = (r: { id: unknown; ref: unknown }) => encodeURIComponent(String(r.ref ?? r.id ?? ""))

export const SECTIONS: Record<PartyKind, SectionSpec[]> = {
  customer: [
    {
      key: "clients", label: "Client accounts", group: "crm", table: "clients",
      features: ["clients.view_clients"],
      links: [{ column: "company_id", from: "id", stable: true }],
      titleColumns: ["client_name"], subtitleColumns: ["client_code", "email"], statusColumns: ["status"], dateColumns: ["created_at"],
      rowHref: (r) => `/modules/clients/client-360?client=${encodeURIComponent(String(r.id))}`, moduleHref: "/modules/clients",
    },
    {
      key: "leads", label: "Leads", group: "crm", table: "sales_leads",
      features: ["sales.view_leads"],
      links: [{ column: "company_id", from: "id", stable: true }, { column: "company_name", from: "name", stable: false }],
      titleColumns: ["contact_person", "lead_code"], subtitleColumns: ["lead_code", "lead_source"], statusColumns: ["lead_status", "status"], dateColumns: ["lead_date", "created_at"],
      rowHref: (r) => `/modules/sales/leads?lead=${ref(r)}`, moduleHref: "/modules/sales/leads",
    },
    {
      key: "quotations", label: "Quotations", group: "crm", table: "sales_quotations",
      features: ["sales.view_quotations"],
      links: [{ column: "company_id", from: "id", stable: true }, { column: "company_name", from: "name", stable: false }],
      titleColumns: ["quote_code"], subtitleColumns: ["opportunity_name"], statusColumns: ["status"], dateColumns: ["quote_date", "created_at"], amountColumns: ["total_amount"],
      rowHref: (r) => `/modules/sales/quotations?quote=${ref(r)}`, moduleHref: "/modules/sales/quotations",
    },
    {
      key: "contracts", label: "Contracts", group: "contracts", table: "sales_contracts",
      features: ["sales.view_contracts"],
      links: [{ column: "company_id", from: "id", stable: true }, { column: "company_name", from: "name", stable: false }],
      titleColumns: ["contract_code"], subtitleColumns: ["contract_type"], statusColumns: ["status"], dateColumns: ["start_date", "contract_date"], amountColumns: ["value"],
      rowHref: (r) => `/modules/sales/contracts?contract=${ref(r)}`, moduleHref: "/modules/sales/contracts",
    },
    {
      key: "invoices", label: "Invoices", group: "finance", table: "sales_invoices",
      features: ["finance.view_sales_invoices"],
      links: [{ column: "client_id", from: "clientIds", stable: true }],
      titleColumns: ["invoice_id"], subtitleColumns: ["project_name"], statusColumns: ["payment_status", "invoice_status"], dateColumns: ["invoice_date"], amountColumns: ["invoice_total"],
      rowHref: (r) => `/modules/finance/sales-invoices?invoice=${ref(r)}`, moduleHref: "/modules/finance/sales-invoices",
    },
    {
      key: "payments", label: "Receipts", group: "finance", table: "payments",
      features: ["finance.view_sales_invoices", "finance.view_bank_cash"],
      links: [{ column: "party_id", from: "financePartyIds", stable: true }],
      titleColumns: ["payment_id"], subtitleColumns: ["invoice_ref", "payment_mode"], statusColumns: ["status"], dateColumns: ["payment_date"], amountColumns: ["amount"],
      rowHref: (r) => `/modules/finance/payments?payment=${ref(r)}`, moduleHref: "/modules/finance/payments",
    },
    {
      key: "documents", label: "Documents", group: "documents", table: "dms_documents",
      features: ["dms.view_documents", "documents.view_documents"],
      links: [{ column: "source_entity_id", from: "id", stable: true }],
      where: [{ column: "source_entity_type", values: ["sales_company", "company", "customer"] }],
      titleColumns: ["title"], subtitleColumns: ["source_module"], statusColumns: ["status"], dateColumns: ["created_at"],
      rowHref: (r) => `/modules/documents?doc=${encodeURIComponent(String(r.id))}`, moduleHref: "/modules/documents",
    },
    {
      key: "activity", label: "Activity", group: "activity", table: "sales_audit_log",
      features: ["sales.view_companies"],
      links: [{ column: "entity_id", from: "id", stable: true }],
      where: [{ column: "entity_type", values: ["company", "sales_company"] }],
      titleColumns: ["summary", "action"], subtitleColumns: ["action"], dateColumns: ["created_at"],
      rowHref: () => `/modules/sales/companies`, moduleHref: "/modules/sales/companies",
    },
  ],
  vendor: [
    {
      key: "purchase_orders", label: "Purchase orders", group: "finance", table: "procurement_purchase_orders",
      features: ["procurement.view_purchase_orders", "finance.view_purchase_bills"],
      links: [{ column: "vendor_id", from: "id", stable: true }],
      titleColumns: ["po_number"], subtitleColumns: ["item_description"], statusColumns: ["status", "approval_status"], dateColumns: ["order_date"], amountColumns: ["total_amount"],
      rowHref: (r) => `/modules/procurement/purchase-orders?po=${ref(r)}`, moduleHref: "/modules/procurement/purchase-orders",
    },
    {
      key: "bills", label: "Purchase bills", group: "finance", table: "purchase_bills",
      features: ["finance.view_purchase_bills"],
      links: [{ column: "vendor_id", from: "id", stable: true }],
      titleColumns: ["po_number", "description"], subtitleColumns: ["project_name"], statusColumns: ["payment_status"], dateColumns: ["bill_date"], amountColumns: ["net_payable", "gross_bill_amount"],
      rowHref: (r) => `/modules/finance/purchase-bills?bill=${encodeURIComponent(String(r.id))}`, moduleHref: "/modules/finance/purchase-bills",
    },
    {
      key: "payments", label: "Payments", group: "finance", table: "payments",
      features: ["finance.view_purchase_bills", "finance.view_bank_cash"],
      links: [{ column: "party_id", from: "code", stable: true }],
      titleColumns: ["payment_id"], subtitleColumns: ["invoice_ref", "payment_mode"], statusColumns: ["status"], dateColumns: ["payment_date"], amountColumns: ["amount"],
      rowHref: (r) => `/modules/finance/payments?payment=${ref(r)}`, moduleHref: "/modules/finance/payments",
    },
    {
      key: "contracts", label: "Contracts", group: "contracts", table: "legal_generated_contracts",
      features: ["legal.view_contracts"],
      links: [{ column: "party_id", from: "code", stable: true }],
      where: [{ column: "party_type", values: ["vendor", "Vendor", "supplier"] }],
      titleColumns: ["title", "reference_no"], subtitleColumns: ["reference_no", "contract_type"], statusColumns: ["status"], dateColumns: ["effective_date", "created_at"],
      rowHref: (r) => `/modules/legal/contracts?contract=${encodeURIComponent(String(r.id))}`, moduleHref: "/modules/legal/contracts",
    },
    {
      key: "documents", label: "Documents", group: "documents", table: "dms_documents",
      features: ["dms.view_documents", "documents.view_documents"],
      links: [{ column: "source_entity_id", from: "id", stable: true }],
      where: [{ column: "source_entity_type", values: ["vendor", "customers_vendors", "party"] }],
      titleColumns: ["title"], subtitleColumns: ["source_module"], statusColumns: ["status"], dateColumns: ["created_at"],
      rowHref: (r) => `/modules/documents?doc=${encodeURIComponent(String(r.id))}`, moduleHref: "/modules/documents",
    },
    {
      key: "activity", label: "Activity", group: "activity", table: "finance_audit_events",
      features: ["finance.view_customers_vendors"],
      links: [{ column: "entity_pk", from: "id", stable: true }],
      where: [{ column: "entity_type", values: ["customer_vendor", "customers_vendors", "vendor", "party"] }],
      titleColumns: ["summary", "event_type"], subtitleColumns: ["event_type"], dateColumns: ["created_at"],
      rowHref: () => `/modules/finance/customers-vendors`, moduleHref: "/modules/finance/customers-vendors",
    },
  ],
  employee: [
    {
      key: "documents", label: "Documents", group: "documents", table: "hr_employee_documents",
      features: ["hr.view_documents", "hr.view_employees"],
      links: [{ column: "employee_id", from: "id", stable: true }],
      titleColumns: ["document_type"], subtitleColumns: ["file_name"], statusColumns: ["status"], dateColumns: ["created_at"],
      rowHref: () => `/modules/hr/employee-documents`, moduleHref: "/modules/hr/employee-documents",
    },
    {
      key: "assets", label: "Assets", group: "assets", table: "employee_asset_assignments",
      features: ["hr.view_employees", "finance.view_fixed_assets"],
      links: [{ column: "employee_id", from: "id", stable: true }, { column: "employee_ref", from: "code", stable: true }],
      titleColumns: ["assignment_id"], subtitleColumns: ["purpose", "department"], statusColumns: ["status"], dateColumns: ["assignment_date"],
      rowHref: (r) => `/modules/assets/assignments?assignment=${ref(r)}`, moduleHref: "/modules/assets/assignments",
    },
    {
      key: "leave", label: "Leave requests", group: "hr", table: "hr_leave_requests",
      features: ["hr.view_leave_requests", "hr.view_employees"],
      links: [{ column: "employee_id", from: "code", stable: true }],
      titleColumns: ["request_id"], subtitleColumns: ["reason"], statusColumns: ["status"], dateColumns: ["from_date", "requested_at"],
      rowHref: () => `/modules/hr/leave-requests`, moduleHref: "/modules/hr/leave-requests",
    },
    {
      key: "tickets", label: "Support tickets", group: "tickets", table: "hr_support_tickets",
      features: ["hr.view_support"],
      links: [{ column: "employee_id", from: "code", stable: true }],
      titleColumns: ["subject", "ticket_id"], subtitleColumns: ["ticket_id", "support_category"], statusColumns: ["status"], dateColumns: ["created_at"],
      rowHref: () => `/modules/hr/support`, moduleHref: "/modules/hr/support",
    },
    {
      key: "recruitment", label: "Recruitment history", group: "recruitment", table: "recruit_applications",
      features: ["recruitment.view_candidates", "recruitment.candidates"],
      links: [{ column: "hired_employee_id", from: "code", stable: true }],
      titleColumns: ["candidate_name"], subtitleColumns: ["job_title"], statusColumns: ["stage"], dateColumns: ["applied_at", "created_at"],
      rowHref: () => `/modules/recruitment/candidate-360`, moduleHref: "/modules/recruitment/candidate-360",
    },
    {
      key: "activity", label: "Activity", group: "activity", table: "audit_log_entries",
      features: ["hr.manage_employees"],
      links: [{ column: "entity_id", from: "id", stable: true }],
      where: [{ column: "entity_type", values: ["hr_employee", "employee"] }],
      titleColumns: ["action"], subtitleColumns: ["actor_name"], statusColumns: ["result"], dateColumns: ["created_at"],
      rowHref: () => `/modules/hr/employees`, moduleHref: "/modules/hr/employees",
    },
  ],
}

export type SectionStatus = "ok" | "forbidden" | "missing_module" | "not_linked" | "unscoped" | "error"

export type SectionItem = {
  id: string
  title: string
  subtitle: string | null
  status: string | null
  date: string | null
  amount: number | null
  href: string
}

export type SectionResult = {
  key: string
  label: string
  group: SectionGroup
  status: SectionStatus
  count: number
  items: SectionItem[]
  moduleHref: string
}

/**
 * Pick the links that may be used safely. Name-based links are only allowed
 * when the child table enforces tenant scope itself; stable id links are safe
 * because the anchor id was already tenant-verified.
 */
export function usableLinks(
  links: SectionLink[],
  childColumns: Set<string>,
  childHasTenant: boolean,
): { links: SectionLink[]; droppedUnscoped: boolean } {
  let droppedUnscoped = false
  const out = links.filter((l) => {
    if (!childColumns.has(l.column)) return false
    if (!l.stable && !childHasTenant) {
      droppedUnscoped = true
      return false
    }
    return true
  })
  return { links: out, droppedUnscoped }
}

export function firstPresent(row: Record<string, unknown>, columns: string[] | undefined): unknown {
  for (const c of columns ?? []) {
    const v = row[c]
    if (v != null && String(v).trim() !== "") return v
  }
  return null
}

export type ViewScope = "full" | "self"

/**
 * Decide whether the viewer may open a record. `full` needs the kind's view
 * feature; `self` lets an employee open ONLY their own employee 360.
 */
export function decideAccess(
  kind: PartyKind,
  hasViewFeature: boolean,
  opts: { viewerUserId: number; recordUserId?: unknown },
): ViewScope | null {
  if (hasViewFeature) return "full"
  if (kind === "employee" && opts.recordUserId != null && Number(opts.recordUserId) === opts.viewerUserId) return "self"
  return null
}
