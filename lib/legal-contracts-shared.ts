// ---------------------------------------------------------------------------
// Legal Contracts — client-safe shared config, catalogs and types.
//
// NO server-only imports (no mysql2, no "server-only") so the template console,
// rich editor and generate wizard can import it in the browser. Every server
// module re-exports the pieces it needs from here. Mirrors the structure of
// lib/hr-letters-shared.ts, adapted for the multi-source contract engine.
// ---------------------------------------------------------------------------

// --- Contract types (seed list — NOT a hard limit) --------------------------
// The DB stores a free string; these are the built-in suggestions surfaced in
// the UI. New types typed by users are accepted and persisted as-is.
export const CONTRACT_TYPES = [
  "MSA",
  "NDA",
  "SLA",
  "Client Agreement",
  "Vendor Agreement",
  "Employment Agreement",
  "Offer Letter",
  "Appointment Letter",
  "Internship Agreement",
  "Freelancer Agreement",
  "Consultancy Agreement",
  "Service Agreement",
  "MoU",
  "Work Order",
  "Purchase Agreement",
  "Partnership Agreement",
  "Confidentiality Agreement",
  "Data Processing Agreement",
  "Termination Letter",
  "Other",
] as const
export type ContractType = (typeof CONTRACT_TYPES)[number]

// --- Categories -------------------------------------------------------------
export const CONTRACT_CATEGORIES = [
  "Client",
  "Vendor",
  "Employee",
  "Recruitment",
  "Finance",
  "Operations",
  "Legal",
  "Compliance",
  "Confidentiality",
  "Commercial",
  "Other",
] as const
export type ContractCategory = (typeof CONTRACT_CATEGORIES)[number]

// --- Template lifecycle -----------------------------------------------------
export const TEMPLATE_STATUSES = ["Draft", "In Review", "Approved", "Published", "Archived", "Expired"] as const
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number]

/** Allowed template status transitions. Empty array = terminal. */
export const TEMPLATE_TRANSITIONS: Record<TemplateStatus, TemplateStatus[]> = {
  Draft: ["In Review", "Archived"],
  "In Review": ["Approved", "Draft", "Archived"],
  Approved: ["Published", "In Review", "Archived"],
  Published: ["Archived", "Approved"],
  Archived: ["Draft"],
  Expired: ["Draft", "Archived"],
}

export function canTransitionTemplate(from: string, to: string): boolean {
  const allowed = TEMPLATE_TRANSITIONS[from as TemplateStatus]
  return Array.isArray(allowed) && allowed.includes(to as TemplateStatus)
}

/** Templates selectable for NEW contract generation. */
export const USABLE_TEMPLATE_STATUSES: TemplateStatus[] = ["Approved", "Published"]

// --- Generated contract lifecycle -------------------------------------------
export const CONTRACT_STATUSES = [
  "Draft",
  "Generated",
  "In Review",
  "Approved",
  "Sent",
  "Viewed",
  "Signed",
  "Active",
  "Expired",
  "Terminated",
  "Cancelled",
] as const
export type ContractStatus = (typeof CONTRACT_STATUSES)[number]

// --- Data sources -----------------------------------------------------------
// A contract's variables are resolved from ONE primary source record plus the
// always-available company / user / date groups.
export const CONTRACT_SOURCES = [
  "manual",
  "employee",
  "client",
  "vendor",
  "candidate",
  "project",
] as const
export type ContractSource = (typeof CONTRACT_SOURCES)[number]

export type ContractSourceMeta = {
  key: ContractSource
  label: string
  /** Module the picker fetches records from. */
  module: string
  description: string
  /** Human party role this source represents on the contract. */
  partyRole: string
}

export const CONTRACT_SOURCE_META: ContractSourceMeta[] = [
  { key: "manual", label: "Manual (no source record)", module: "Legal", description: "Fill counterparty details by hand.", partyRole: "Counterparty" },
  { key: "employee", label: "Employee", module: "HR", description: "Employment, appointment & internal agreements.", partyRole: "Employee" },
  { key: "client", label: "Client", module: "Sales / Clients", description: "Client agreements, MSA, SLA, service agreements.", partyRole: "Client" },
  { key: "vendor", label: "Vendor", module: "Finance", description: "Vendor & purchase agreements.", partyRole: "Vendor" },
  { key: "candidate", label: "Candidate", module: "Recruitment", description: "Offer, internship & freelancer agreements.", partyRole: "Candidate" },
  { key: "project", label: "Project", module: "Operations", description: "Work orders & project / service agreements.", partyRole: "Client" },
]

export function sourceMeta(key: string | null | undefined): ContractSourceMeta {
  return CONTRACT_SOURCE_META.find((s) => s.key === key) ?? CONTRACT_SOURCE_META[0]
}

// --- Variable catalog -------------------------------------------------------
export type ContractVariable = {
  token: string
  label: string
  group: string
  /** Data source this variable resolves from. */
  source: ContractSource | "company" | "contract" | "user" | "date"
  required?: boolean
  example?: string
}

/** Always-available variables (company profile, contract dates, user, date). */
export const CONTRACT_BASE_VARIABLES: ContractVariable[] = [
  // Company profile
  { token: "company_name", label: "Company name", group: "Company", source: "company", example: "Muenot Technologies Pvt Ltd" },
  { token: "company_legal_name", label: "Company legal name", group: "Company", source: "company" },
  { token: "company_address", label: "Company registered address", group: "Company", source: "company" },
  { token: "company_gstin", label: "Company GSTIN", group: "Company", source: "company" },
  { token: "company_pan", label: "Company PAN", group: "Company", source: "company" },
  { token: "company_cin", label: "Company CIN", group: "Company", source: "company" },
  { token: "company_email", label: "Company email", group: "Company", source: "company" },
  { token: "company_phone", label: "Company phone", group: "Company", source: "company" },
  { token: "company_website", label: "Company website", group: "Company", source: "company" },
  { token: "authorized_signatory", label: "Authorized signatory", group: "Company", source: "company" },
  { token: "signatory_designation", label: "Signatory designation", group: "Company", source: "company" },
  // Contract dates / meta
  { token: "contract_id", label: "Contract ID", group: "Contract", source: "contract", example: "CTR-0007" },
  { token: "contract_reference", label: "Contract reference no", group: "Contract", source: "contract" },
  { token: "contract_title", label: "Contract title", group: "Contract", source: "contract" },
  { token: "contract_effective_date", label: "Effective date", group: "Contract", source: "contract" },
  { token: "contract_start_date", label: "Start date", group: "Contract", source: "contract" },
  { token: "contract_end_date", label: "End date", group: "Contract", source: "contract" },
  { token: "contract_renewal_date", label: "Renewal date", group: "Contract", source: "contract" },
  // User / date
  { token: "generated_by", label: "Generated by (user)", group: "General", source: "user" },
  { token: "today", label: "Today's date", group: "General", source: "date", example: "17 September 2026" },
]

/** Extra variables contributed by each primary source. */
export const CONTRACT_SOURCE_VARIABLES: Record<ContractSource, ContractVariable[]> = {
  manual: [
    { token: "party_name", label: "Counterparty name", group: "Counterparty", source: "manual" },
    { token: "party_legal_name", label: "Counterparty legal name", group: "Counterparty", source: "manual" },
    { token: "party_address", label: "Counterparty address", group: "Counterparty", source: "manual" },
    { token: "party_email", label: "Counterparty email", group: "Counterparty", source: "manual" },
    { token: "party_gstin", label: "Counterparty GSTIN", group: "Counterparty", source: "manual" },
  ],
  employee: [
    { token: "employee_name", label: "Employee name", group: "Employee", source: "employee", example: "Sandeep Kumar" },
    { token: "employee_id", label: "Employee ID", group: "Employee", source: "employee", example: "EMP-0042" },
    { token: "designation", label: "Designation", group: "Employee", source: "employee" },
    { token: "department", label: "Department", group: "Employee", source: "employee" },
    { token: "joining_date", label: "Joining date", group: "Employee", source: "employee" },
    { token: "employment_type", label: "Employment type", group: "Employee", source: "employee" },
    { token: "work_email", label: "Work email", group: "Employee", source: "employee" },
    { token: "employee_phone", label: "Phone", group: "Employee", source: "employee" },
    { token: "employee_address", label: "Address", group: "Employee", source: "employee" },
    { token: "salary", label: "Salary / CTC", group: "Employee", source: "employee" },
    { token: "date_of_birth", label: "Date of birth", group: "Employee", source: "employee" },
  ],
  client: [
    { token: "client_name", label: "Client contact name", group: "Client", source: "client" },
    { token: "client_legal_name", label: "Client legal name", group: "Client", source: "client" },
    { token: "client_company", label: "Client company", group: "Client", source: "client" },
    { token: "client_address", label: "Client address", group: "Client", source: "client" },
    { token: "client_gstin", label: "Client GSTIN", group: "Client", source: "client" },
    { token: "client_pan", label: "Client PAN", group: "Client", source: "client" },
    { token: "client_email", label: "Client email", group: "Client", source: "client" },
    { token: "client_phone", label: "Client phone", group: "Client", source: "client" },
  ],
  vendor: [
    { token: "vendor_name", label: "Vendor name", group: "Vendor", source: "vendor" },
    { token: "vendor_legal_name", label: "Vendor legal name", group: "Vendor", source: "vendor" },
    { token: "vendor_address", label: "Vendor address", group: "Vendor", source: "vendor" },
    { token: "vendor_gstin", label: "Vendor GSTIN", group: "Vendor", source: "vendor" },
    { token: "vendor_pan", label: "Vendor PAN", group: "Vendor", source: "vendor" },
    { token: "vendor_email", label: "Vendor email", group: "Vendor", source: "vendor" },
    { token: "vendor_phone", label: "Vendor phone", group: "Vendor", source: "vendor" },
  ],
  candidate: [
    { token: "candidate_name", label: "Candidate name", group: "Candidate", source: "candidate" },
    { token: "candidate_email", label: "Candidate email", group: "Candidate", source: "candidate" },
    { token: "candidate_phone", label: "Candidate phone", group: "Candidate", source: "candidate" },
    { token: "offered_designation", label: "Offered designation", group: "Candidate", source: "candidate" },
    { token: "offered_department", label: "Offered department", group: "Candidate", source: "candidate" },
    { token: "offered_salary", label: "Offered salary / CTC", group: "Candidate", source: "candidate" },
    { token: "proposed_joining_date", label: "Proposed joining date", group: "Candidate", source: "candidate" },
  ],
  project: [
    { token: "project_name", label: "Project name", group: "Project", source: "project" },
    { token: "project_id", label: "Project ID", group: "Project", source: "project" },
    { token: "project_client", label: "Project client", group: "Project", source: "project" },
    { token: "project_start_date", label: "Project start date", group: "Project", source: "project" },
    { token: "project_end_date", label: "Project end date", group: "Project", source: "project" },
    { token: "project_scope", label: "Project scope", group: "Project", source: "project" },
    { token: "project_manager", label: "Project manager", group: "Project", source: "project" },
  ],
}

/** Full variable catalog for a template bound to the given source. */
export function variablesForSource(source: string | null | undefined): ContractVariable[] {
  const key = (CONTRACT_SOURCES as readonly string[]).includes(source as string)
    ? (source as ContractSource)
    : "manual"
  const extras = CONTRACT_SOURCE_VARIABLES[key] ?? []
  return [...extras, ...CONTRACT_BASE_VARIABLES]
}

/** Every token across every source — used for lenient validation. */
export function allKnownTokens(): Set<string> {
  const set = new Set<string>(CONTRACT_BASE_VARIABLES.map((v) => v.token))
  for (const list of Object.values(CONTRACT_SOURCE_VARIABLES)) {
    for (const v of list) set.add(v.token)
  }
  return set
}

// --- Token extraction (pure) ------------------------------------------------
const TOKEN_RE = /\{\{\s*(?:#if|#each)?\s*([\w.$]+)\s*\}\}/g
const CONTROL_TOKENS = new Set(["this", "else"])

export function extractVariables(...texts: (string | null | undefined)[]): string[] {
  const found = new Set<string>()
  for (const text of texts) {
    if (!text) continue
    let m: RegExpExecArray | null
    TOKEN_RE.lastIndex = 0
    while ((m = TOKEN_RE.exec(text))) {
      const raw = m[1]
      if (!raw || raw.startsWith("/")) continue
      const base = raw.split(".")[0]
      if (CONTROL_TOKENS.has(base)) continue
      found.add(raw)
    }
  }
  return Array.from(found)
}

// --- Row types --------------------------------------------------------------
export type ContractTemplate = {
  id: number
  template_uid: string | null
  name: string
  contract_type: string
  category: string
  description: string | null
  source: string
  version: number
  status: TemplateStatus
  content: string
  required_variables: string[] | null
  owner_id: number | null
  usage_count: number
  last_used_at: string | null
  review_date: string | null
  expiry_date: string | null
  created_by: number | null
  updated_by: number | null
  created_at: string | null
  updated_at: string | null
  // Joined display fields
  owner_name?: string | null
  created_by_name?: string | null
}

export type ContractTemplateVersion = {
  id: number
  template_id: number
  version: number
  name: string
  contract_type: string
  category: string
  source: string
  status: string
  content: string
  change_note: string | null
  changed_by: number | null
  changed_by_name?: string | null
  created_at: string | null
}

export type GeneratedContract = {
  id: number
  contract_uid: string
  reference_no: string | null
  title: string
  template_id: number | null
  template_version: number | null
  contract_type: string
  category: string | null
  source: string
  source_ref: string | null
  party_type: string | null
  party_name: string | null
  party_id: string | null
  content: string
  status: ContractStatus
  version: number
  effective_date: string | null
  start_date: string | null
  end_date: string | null
  renewal_date: string | null
  document_id: number | null
  variables_snapshot: Record<string, string> | null
  supersedes_id: number | null
  superseded_by: number | null
  dedupe_key: string | null
  generated_by: number | null
  created_at: string | null
  updated_at: string | null
  // Joined display fields
  template_name?: string | null
  generated_by_name?: string | null
}

// --- Display helpers (pure) -------------------------------------------------
export function templateStatusTone(status: string): "green" | "blue" | "amber" | "slate" | "red" {
  switch (status) {
    case "Published":
      return "green"
    case "Approved":
      return "blue"
    case "In Review":
      return "amber"
    case "Draft":
      return "slate"
    case "Archived":
    case "Expired":
      return "red"
    default:
      return "slate"
  }
}

export function contractStatusTone(status: string): "green" | "blue" | "amber" | "slate" | "red" {
  switch (status) {
    case "Active":
    case "Signed":
      return "green"
    case "Sent":
    case "Viewed":
    case "Approved":
      return "blue"
    case "Generated":
    case "In Review":
      return "amber"
    case "Expired":
    case "Terminated":
    case "Cancelled":
      return "red"
    default:
      return "slate"
  }
}
