// ---------------------------------------------------------------------------
// HR Letters — client-safe shared config, catalogs and types.
//
// This module has NO server-only imports (no mysql2, no "server-only"), so it
// can be imported freely by client components (the template console, editor and
// generate wizard) without dragging the database driver into the browser
// bundle. All server modules re-export the pieces they need from here.
// ---------------------------------------------------------------------------

// --- Categories -------------------------------------------------------------
export const LETTER_CATEGORIES = [
  "Onboarding",
  "Employment",
  "Confirmation",
  "Compensation",
  "Promotion",
  "Recognition",
  "Disciplinary",
  "Separation",
  "Verification",
  "General",
] as const
export type LetterCategory = (typeof LETTER_CATEGORIES)[number]

// --- Letter types (kept as the legacy list + extras) ------------------------
export const LETTER_TYPES = [
  "Offer Letter",
  "Appointment Letter",
  "Confirmation Letter",
  "Experience Letter",
  "Relieving Letter",
  "Promotion Letter",
  "Increment Letter",
  "Warning Letter",
  "Termination Letter",
  "Address Proof",
  "Salary Certificate",
  "No Objection Certificate",
  "Other",
] as const
export type LetterType = (typeof LETTER_TYPES)[number]

// --- Audience ---------------------------------------------------------------
export const LETTER_AUDIENCES = ["Employee", "Candidate", "Manager", "Authority", "Other"] as const
export type LetterAudience = (typeof LETTER_AUDIENCES)[number]

// --- Template lifecycle -----------------------------------------------------
export const LETTER_TEMPLATE_STATUSES = ["Draft", "Active", "Inactive", "Archived"] as const
export type LetterTemplateStatus = (typeof LETTER_TEMPLATE_STATUSES)[number]

/** Allowed status transitions. Empty array = terminal from that state. */
export const LETTER_TEMPLATE_TRANSITIONS: Record<LetterTemplateStatus, LetterTemplateStatus[]> = {
  Draft: ["Active", "Archived"],
  Active: ["Inactive", "Archived"],
  Inactive: ["Active", "Archived"],
  Archived: ["Draft"],
}

export function canTransitionTemplate(from: string, to: string): boolean {
  const allowed = LETTER_TEMPLATE_TRANSITIONS[from as LetterTemplateStatus]
  return Array.isArray(allowed) && allowed.includes(to as LetterTemplateStatus)
}

// --- Generated letter lifecycle ---------------------------------------------
export const LETTER_STATUSES = ["Draft", "Generated", "Issued", "Delivered", "Cancelled"] as const
export type LetterStatus = (typeof LETTER_STATUSES)[number]

// --- Source / event model ---------------------------------------------------
// A letter can be produced manually or driven by a business event in another
// module. `source` is the record family the generator pulls context from.
export const LETTER_SOURCES = ["manual", "employee", "promotion", "offboarding", "recruitment"] as const
export type LetterSource = (typeof LETTER_SOURCES)[number]

export type LetterEvent = {
  key: string
  label: string
  source: LetterSource
  description: string
}

export const LETTER_EVENTS: LetterEvent[] = [
  { key: "manual", label: "Manual", source: "manual", description: "Generated on demand for any employee." },
  { key: "employee_confirmation", label: "Probation Confirmation", source: "employee", description: "Employee confirmed after probation." },
  { key: "promotion", label: "Promotion / Increment", source: "promotion", description: "Approved promotion or salary revision." },
  { key: "offboarding", label: "Offboarding / Relieving", source: "offboarding", description: "Exit cleared — relieving/experience." },
  { key: "recruitment_offer", label: "Recruitment Offer", source: "recruitment", description: "Offer extended to a selected candidate." },
]

export function eventByKey(key: string | null | undefined): LetterEvent {
  return LETTER_EVENTS.find((e) => e.key === key) ?? LETTER_EVENTS[0]
}

// --- Variable catalog -------------------------------------------------------
export type LetterVariable = { token: string; label: string; group: string; example?: string }

/** Variables always available, resolved from the employee + company records. */
export const LETTER_BASE_VARIABLES: LetterVariable[] = [
  { token: "employee_name", label: "Employee name", group: "Employee", example: "Priya Sharma" },
  { token: "employee_code", label: "Employee code", group: "Employee", example: "EMP-0042" },
  { token: "designation", label: "Designation", group: "Employee", example: "Senior Engineer" },
  { token: "department", label: "Department", group: "Employee", example: "Engineering" },
  { token: "joining_date", label: "Joining date", group: "Employee", example: "01 April 2024" },
  { token: "confirmation_date", label: "Confirmation date", group: "Employee", example: "01 October 2024" },
  { token: "official_email", label: "Official email", group: "Employee", example: "priya@acme.com" },
  { token: "personal_email", label: "Personal email", group: "Employee" },
  { token: "mobile", label: "Mobile", group: "Employee" },
  { token: "work_location", label: "Work location", group: "Employee", example: "Bengaluru" },
  { token: "employment_type", label: "Employment type", group: "Employee", example: "Full-time" },
  { token: "reporting_manager", label: "Reporting manager", group: "Employee" },
  { token: "employee_grade", label: "Grade", group: "Employee" },
  { token: "company_name", label: "Company name", group: "Company", example: "Acme Corp" },
  { token: "company_email", label: "Company email", group: "Company" },
  { token: "company_phone", label: "Company phone", group: "Company" },
  { token: "company_address", label: "Company address", group: "Company" },
  { token: "letter_number", label: "Letter number", group: "Letter", example: "LTR-0007" },
  { token: "letter_date", label: "Letter date", group: "Letter", example: "13 September 2026" },
  { token: "today", label: "Today's date", group: "Letter" },
]

/** Extra variables contributed by an event source. */
export const LETTER_EVENT_VARIABLES: Record<LetterSource, LetterVariable[]> = {
  manual: [],
  employee: [{ token: "confirmation_date", label: "Confirmation date", group: "Confirmation" }],
  promotion: [
    { token: "previous_designation", label: "Previous designation", group: "Promotion" },
    { token: "new_designation", label: "New designation", group: "Promotion" },
    { token: "previous_department", label: "Previous department", group: "Promotion" },
    { token: "new_department", label: "New department", group: "Promotion" },
    { token: "previous_salary", label: "Previous salary", group: "Promotion" },
    { token: "new_salary", label: "New salary (CTC)", group: "Promotion" },
    { token: "effective_date", label: "Effective date", group: "Promotion" },
  ],
  offboarding: [
    { token: "exit_date", label: "Last working day", group: "Offboarding" },
    { token: "exit_reason", label: "Exit reason", group: "Offboarding" },
    { token: "notice_period", label: "Notice period", group: "Offboarding" },
    { token: "tenure", label: "Tenure", group: "Offboarding", example: "2 years 3 months" },
  ],
  recruitment: [
    { token: "candidate_name", label: "Candidate name", group: "Recruitment" },
    { token: "offered_designation", label: "Offered designation", group: "Recruitment" },
    { token: "offered_department", label: "Offered department", group: "Recruitment" },
    { token: "offered_salary", label: "Offered salary (CTC)", group: "Recruitment" },
    { token: "proposed_joining_date", label: "Proposed joining date", group: "Recruitment" },
    { token: "offer_valid_till", label: "Offer valid till", group: "Recruitment" },
  ],
}

/** Full variable catalog available to a template with the given event key. */
export function variablesForEvent(eventKey: string | null | undefined): LetterVariable[] {
  const evt = eventByKey(eventKey)
  const extras = LETTER_EVENT_VARIABLES[evt.source] ?? []
  // De-dupe by token (event vars may re-declare a base one for grouping).
  const seen = new Set(LETTER_BASE_VARIABLES.map((v) => v.token))
  return [...LETTER_BASE_VARIABLES, ...extras.filter((v) => !seen.has(v.token))]
}

// --- Token extraction (pure — safe on the client) ---------------------------
// Matches {{ token }}, {{#if token}}, {{#each token}} — ignores block-closers.
const TOKEN_RE = /\{\{\s*(?:#if|#each)?\s*([\w.$]+)\s*\}\}/g
const CONTROL_TOKENS = new Set(["this", "else"])

/** Distinct variable names referenced by a template string (dotted → base). */
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
export type LetterTemplate = {
  id: number
  template_uid: string | null
  template_key: string | null
  name: string
  description: string | null
  category: string
  letter_type: string
  audience: string
  event_key: string
  subject: string
  body: string
  status: LetterTemplateStatus
  version: number
  usage_count: number
  last_used_at: string | null
  required_variables: string[] | null
  created_by: number | null
  updated_by: number | null
  created_at: string | null
  updated_at: string | null
}

export type LetterTemplateVersion = {
  id: number
  template_id: number
  version: number
  name: string
  subject: string
  body: string
  category: string
  letter_type: string
  audience: string
  event_key: string
  status: string
  change_note: string | null
  changed_by: number | null
  changed_by_name: string | null
  created_at: string | null
}

export type GeneratedLetter = {
  id: number
  letter_number: string
  employee_id: number
  template_id: number | null
  template_version: number | null
  letter_type: string
  category: string | null
  audience: string | null
  subject: string
  body: string
  issue_date: string
  status: LetterStatus
  source: string
  source_ref: string | null
  document_id: number | null
  email_id: number | null
  supersedes_id: number | null
  superseded_by: number | null
  dedupe_key: string | null
  created_by: number | null
  created_at: string | null
  updated_at: string | null
  // Joined display fields
  employee_name?: string
  employee_code?: string
  designation?: string
  department?: string
}

// --- Small display helpers (pure) -------------------------------------------
export function templateStatusTone(status: string): "green" | "amber" | "slate" | "red" {
  switch (status) {
    case "Active":
      return "green"
    case "Draft":
      return "amber"
    case "Inactive":
      return "slate"
    case "Archived":
      return "red"
    default:
      return "slate"
  }
}

export function letterStatusTone(status: string): "green" | "amber" | "slate" | "red" | "blue" {
  switch (status) {
    case "Delivered":
      return "green"
    case "Issued":
      return "blue"
    case "Generated":
      return "amber"
    case "Cancelled":
      return "red"
    default:
      return "slate"
  }
}
