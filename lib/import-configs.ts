/**
 * Central, config-driven registry that powers the bulk "Import" facility shared
 * by every list sub-module across the ERP (Sales, HR, Recruit, Finance,
 * Operations and shared tools). A single entry here gives a module both a
 * server-side importer (see app/api/import/[key]/route.ts) and a client button
 * (see components/import-button.tsx) — no per-module route or wiring required.
 *
 * This file is intentionally free of server-only imports (no db, no auth) so it
 * can be shared by both the client button and the server route.
 */

export type ImportColumnType = "string" | "number" | "date"

export type ImportColumn = {
  /** Canonical DB column name the value is inserted into. */
  key: string
  /** Human-friendly header shown in the downloadable template. */
  label: string
  /** Extra spreadsheet header spellings to accept (normalized on use). */
  aliases?: string[]
  /** Value coercion. Defaults to "string". */
  type?: ImportColumnType
  /** When true, a row missing this value is rejected with a clear error. */
  required?: boolean
  /** Fallback value used when the cell is empty. */
  default?: string | number
  /** Example value written into the template's sample row. */
  sample?: string
}

/**
 * How a module mints the human-readable code stored in `idColumn`:
 * - "sequence": uses nextRecordId + the shared record_id_sequences table.
 * - "maxSubstring": mirrors the modules that compute the next number from
 *   MAX(CAST(SUBSTRING(code, from) AS UNSIGNED)) + 1 on their own table.
 */
export type IdStrategy =
  | { strategy: "sequence"; prefix: string; allowCustom?: boolean }
  | { strategy: "maxSubstring"; prefix: string; substringFrom: number; digits: number }

export type ImportConfig = {
  /** Target SQL table. */
  table: string
  /** Permission slug checked with requireFeature; omit to only require a session. */
  feature?: string
  /** Column that receives the generated record id/code (e.g. "employee_id"). */
  idColumn?: string
  /** How to generate the value for idColumn. */
  id?: IdStrategy
  /** Column that stores the creating user id. Set null to skip. Defaults to "created_by". */
  createdBy?: string | null
  /** Static column values applied to every imported row. */
  defaults?: Record<string, unknown>
  /** Importable columns. */
  columns: ImportColumn[]
}

/** Lowercase, alphanumeric-only key used to match spreadsheet headers loosely. */
export function normalizeImportKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * The registry. Keys are stable url-safe module slugs used in the import
 * endpoint (/api/import/<key>) and by <ImportButton moduleKey="<key>" />.
 */
export const IMPORT_CONFIGS: Record<string, ImportConfig> = {}

export function getImportConfig(key: string): ImportConfig | undefined {
  return IMPORT_CONFIGS[key]
}

/**
 * Builds the alias table the client ExcelImportButton needs: for every column
 * we accept its canonical key, its label, and any explicit aliases (all
 * normalized), so messy real-world headers still map correctly.
 */
export function buildAliases(config: ImportConfig): Record<string, string[]> {
  const aliases: Record<string, string[]> = {}
  for (const col of config.columns) {
    const set = new Set<string>()
    set.add(normalizeImportKey(col.key))
    set.add(normalizeImportKey(col.label))
    for (const extra of col.aliases ?? []) set.add(normalizeImportKey(extra))
    aliases[col.key] = Array.from(set).filter(Boolean)
  }
  return aliases
}

export function templateHeaders(config: ImportConfig): string[] {
  return config.columns.map((c) => c.label)
}

export function templateSample(config: ImportConfig): string[] {
  return config.columns.map((c) => c.sample ?? "")
}

/* ------------------------------------------------------------------ *
 * Sales
 * ------------------------------------------------------------------ */
Object.assign(IMPORT_CONFIGS, {
  "sales-quotations": {
    table: "sales_quotations",
    feature: "sales.manage_quotations",
    idColumn: "quote_code",
    id: { strategy: "maxSubstring", prefix: "MQ-", substringFrom: 4, digits: 3 },
    createdBy: "added_by",
    columns: [
      { key: "quote_date", label: "Date", type: "date", default: "@today", sample: "2025-01-15" },
      { key: "company_name", label: "Company", required: true, sample: "Acme Corp" },
      { key: "contact_person", label: "Contact Person", sample: "Jane Doe" },
      { key: "opportunity_name", label: "Opportunity", sample: "Annual license" },
      { key: "total_amount", label: "Amount", type: "number", required: true, sample: "150000" },
      { key: "valid_until", label: "Valid Until", type: "date", sample: "2025-02-15" },
      { key: "status", label: "Status", default: "Draft", sample: "Draft" },
    ],
  },
  "sales-contracts": {
    table: "sales_contracts",
    feature: "sales.manage_contracts",
    idColumn: "contract_code",
    id: { strategy: "maxSubstring", prefix: "CT-", substringFrom: 4, digits: 3 },
    createdBy: "added_by",
    columns: [
      { key: "contract_date", label: "Date", type: "date", default: "@today", sample: "2025-01-15" },
      { key: "company_name", label: "Company", required: true, sample: "Acme Corp" },
      { key: "start_date", label: "Start Date", type: "date", sample: "2025-02-01" },
      { key: "end_date", label: "End Date", type: "date", sample: "2026-01-31" },
      { key: "value", label: "Value", type: "number", required: true, sample: "500000" },
      { key: "contract_type", label: "Type", sample: "Annual" },
      { key: "status", label: "Status", default: "Draft", sample: "Draft" },
      { key: "signed_by_client", label: "Signed By Client", sample: "John Client" },
      { key: "signed_by_company", label: "Signed By Company", sample: "Sara Rep" },
      { key: "notes", label: "Notes", sample: "" },
    ],
  },
  "sales-onboarding": {
    table: "sales_onboarding",
    feature: "sales.manage_onboarding",
    idColumn: "onboarding_code",
    id: { strategy: "maxSubstring", prefix: "OB-", substringFrom: 4, digits: 3 },
    createdBy: "added_by",
    columns: [
      { key: "onboarding_date", label: "Date", type: "date", default: "@today", sample: "2025-01-15" },
      { key: "company_name", label: "Company", required: true, sample: "Acme Corp" },
      { key: "contract_code", label: "Contract", sample: "CT-001" },
      { key: "start_date", label: "Start Date", type: "date", sample: "2025-02-01" },
      { key: "kickoff_meeting_date", label: "Kickoff Date", type: "date", sample: "2025-02-03" },
      { key: "current_stage", label: "Stage", default: "Kickoff", sample: "Kickoff" },
      { key: "status", label: "Status", default: "Not Started", sample: "Not Started" },
      { key: "onboarding_by", label: "Owner", sample: "Sara Rep" },
    ],
  },
  "sales-meetings": {
    table: "sales_meetings",
    feature: "sales.manage_meetings",
    idColumn: "meeting_code",
    id: { strategy: "maxSubstring", prefix: "MM-", substringFrom: 4, digits: 3 },
    createdBy: "added_by",
    columns: [
      { key: "meeting_date", label: "Date", type: "date", required: true, sample: "2025-01-15" },
      { key: "meeting_time", label: "Time", sample: "14:30" },
      { key: "company_name", label: "Company", required: true, sample: "Acme Corp" },
      { key: "contact_person", label: "Contact Person", sample: "Jane Doe" },
      { key: "meeting_type", label: "Type", default: "Discovery", sample: "Discovery" },
      { key: "agenda", label: "Agenda", sample: "Intro call" },
      { key: "outcome_notes", label: "Outcome Notes", sample: "" },
      { key: "next_steps", label: "Next Steps", sample: "" },
      { key: "duration_minutes", label: "Duration (minutes)", type: "number", sample: "30" },
    ],
  },
  "sales-email-templates": {
    table: "sales_email_templates",
    feature: "sales.manage_email_templates",
    columns: [
      { key: "name", label: "Name", required: true, sample: "Welcome" },
      { key: "subject", label: "Subject", required: true, sample: "Welcome to {{company_name}}" },
      { key: "body", label: "Body", required: true, sample: "Hi {{contact_person}}, ..." },
      { key: "category", label: "Category", sample: "Outreach" },
    ],
  },
} satisfies Record<string, ImportConfig>)

/* ------------------------------------------------------------------ *
 * HR
 * ------------------------------------------------------------------ */
Object.assign(IMPORT_CONFIGS, {
  "hr-shifts": {
    table: "hr_shifts",
    createdBy: null,
    // working_hours is a NOT NULL derived column in the manual form; seed it so
    // imports never fail, admins can refine later by editing the shift.
    defaults: { working_hours: 0 },
    columns: [
      { key: "shift_id", label: "Shift ID", required: true, sample: "SHIFT-A" },
      { key: "shift_name", label: "Shift Name", required: true, sample: "General" },
      { key: "start_time", label: "Start Time", required: true, sample: "09:00" },
      { key: "end_time", label: "End Time", required: true, sample: "18:00" },
      { key: "break_minutes", label: "Break Minutes", type: "number", default: 0, sample: "60" },
      { key: "overtime_enabled", label: "Overtime Enabled", type: "number", default: 0, sample: "0" },
      { key: "status", label: "Status", default: "Active", sample: "Active" },
      { key: "description", label: "Description", sample: "" },
    ],
  },
  "hr-leave-types": {
    table: "hr_leave_types",
    createdBy: null,
    columns: [
      { key: "leave_type_id", label: "Leave Type ID", required: true, sample: "CL" },
      { key: "leave_type", label: "Leave Type", required: true, sample: "Casual Leave" },
      { key: "annual_quota", label: "Annual Quota", type: "number", default: 0, sample: "12" },
      { key: "carry_forward", label: "Carry Forward", type: "number", default: 0, sample: "5" },
      { key: "max_consecutive_days", label: "Max Consecutive Days", type: "number", default: 0, sample: "3" },
      { key: "requires_document", label: "Requires Document", type: "number", default: 0, sample: "0" },
      { key: "paid", label: "Paid", type: "number", default: 1, sample: "1" },
      { key: "status", label: "Status", default: "Active", sample: "Active" },
      { key: "description", label: "Description", sample: "" },
    ],
  },
  "hr-leave-requests": {
    table: "hr_leave_requests",
    createdBy: null,
    idColumn: "request_id",
    id: { strategy: "sequence", prefix: "LR", allowCustom: true },
    columns: [
      { key: "employee_id", label: "Employee ID", type: "number", required: true, sample: "101" },
      { key: "employee_name", label: "Employee Name", sample: "Jane Doe" },
      { key: "leave_type_id", label: "Leave Type ID", required: true, sample: "CL" },
      { key: "from_date", label: "From Date", type: "date", required: true, sample: "2025-02-01" },
      { key: "to_date", label: "To Date", type: "date", required: true, sample: "2025-02-03" },
      { key: "days", label: "Days", type: "number", default: 1, sample: "3" },
      { key: "reason", label: "Reason", sample: "Family function" },
      { key: "status", label: "Status", default: "Pending", sample: "Pending" },
    ],
  },
  "hr-leave-balances": {
    table: "hr_leave_balances",
    createdBy: null,
    columns: [
      { key: "employee_id", label: "Employee ID", type: "number", required: true, sample: "101" },
      { key: "leave_type_id", label: "Leave Type ID", type: "number", required: true, sample: "1" },
      { key: "year", label: "Year", type: "number", required: true, sample: "2025" },
      { key: "opening", label: "Opening", type: "number", default: 0, sample: "12" },
      { key: "accrued", label: "Accrued", type: "number", default: 0, sample: "0" },
      { key: "used", label: "Used", type: "number", default: 0, sample: "0" },
      { key: "pending", label: "Pending", type: "number", default: 0, sample: "0" },
      { key: "adjusted", label: "Adjusted", type: "number", default: 0, sample: "0" },
    ],
  },
  "hr-leave-quota-history": {
    table: "hr_leave_quota_history",
    createdBy: "created_by",
    columns: [
      { key: "employee_id", label: "Employee ID", type: "number", required: true, sample: "101" },
      { key: "leave_type_id", label: "Leave Type ID", type: "number", required: true, sample: "1" },
      { key: "year", label: "Year", type: "number", required: true, sample: "2025" },
      { key: "event_type", label: "Event Type", required: true, sample: "Credit" },
      { key: "days", label: "Days", type: "number", required: true, sample: "2" },
      { key: "reference", label: "Reference", sample: "" },
      { key: "reason", label: "Reason", required: true, sample: "Annual credit" },
    ],
  },
  "hr-offboarding": {
    table: "hr_offboarding",
    createdBy: null,
    idColumn: "offboarding_id",
    id: { strategy: "sequence", prefix: "OFF", allowCustom: true },
    columns: [
      { key: "employee_id", label: "Employee ID", type: "number", required: true, sample: "101" },
      { key: "notice_date", label: "Notice Date", type: "date", sample: "2025-01-10" },
      { key: "last_working_date", label: "Last Working Date", type: "date", sample: "2025-02-10" },
      { key: "exit_type", label: "Exit Type", default: "Resignation", sample: "Resignation" },
      { key: "exit_reason", label: "Exit Reason", sample: "Better opportunity" },
      { key: "status", label: "Status", default: "In Progress", sample: "In Progress" },
      { key: "remarks", label: "Remarks", sample: "" },
    ],
  },
  "hr-letter-templates": {
    table: "hr_letter_templates",
    createdBy: "created_by",
    columns: [
      { key: "name", label: "Name", required: true, sample: "Offer Letter" },
      { key: "letter_type", label: "Letter Type", default: "Offer Letter", sample: "Offer Letter" },
      { key: "subject", label: "Subject", required: true, sample: "Offer of Employment" },
      { key: "body", label: "Body", required: true, sample: "Dear {{employee_name}}, ..." },
      { key: "status", label: "Status", default: "Active", sample: "Active" },
    ],
  },
  "hr-attendance": {
    table: "hr_attendance",
    createdBy: null,
    defaults: { working_hours: 0 },
    columns: [
      { key: "employee_id", label: "Employee ID", type: "number", required: true, sample: "101" },
      { key: "employee_name", label: "Employee Name", sample: "Jane Doe" },
      { key: "work_date", label: "Work Date", type: "date", required: true, sample: "2025-01-15" },
      { key: "clock_in", label: "Clock In", sample: "2025-01-15 09:00" },
      { key: "clock_out", label: "Clock Out", sample: "2025-01-15 18:00" },
      { key: "break_minutes", label: "Break Minutes", type: "number", default: 0, sample: "60" },
      { key: "status", label: "Status", default: "Present", sample: "Present" },
      { key: "source", label: "Source", default: "Import", sample: "Import" },
      { key: "remarks", label: "Remarks", sample: "" },
    ],
  },
  "hr-attendance-regularisation": {
    table: "hr_attendance_regularisation",
    createdBy: null,
    idColumn: "request_id",
    id: { strategy: "sequence", prefix: "REG", allowCustom: true },
    columns: [
      { key: "employee_id", label: "Employee ID", type: "number", required: true, sample: "101" },
      { key: "employee_name", label: "Employee Name", sample: "Jane Doe" },
      { key: "work_date", label: "Work Date", type: "date", required: true, sample: "2025-01-15" },
      { key: "requested_clock_in", label: "Requested Clock In", sample: "09:00" },
      { key: "requested_clock_out", label: "Requested Clock Out", sample: "18:00" },
      { key: "reason", label: "Reason", required: true, sample: "Missed punch" },
    ],
  },
  "hr-holidays": {
    table: "hr_holidays",
    createdBy: null,
    columns: [
      { key: "holiday_name", label: "Holiday Name", required: true, sample: "Independence Day" },
      { key: "holiday_date", label: "Holiday Date", type: "date", required: true, sample: "2025-08-15" },
      { key: "holiday_type", label: "Type", default: "National", sample: "National" },
      { key: "applicable_state_ut", label: "State/UT", sample: "All" },
      { key: "optional", label: "Optional", type: "number", default: 0, sample: "0" },
      { key: "description", label: "Description", sample: "" },
      { key: "status", label: "Status", default: "Active", sample: "Active" },
      { key: "year", label: "Year", type: "number", sample: "2025" },
    ],
  },
  "hr-departments": {
    table: "hr_departments",
    createdBy: null,
    columns: [
      { key: "department_id", label: "Department ID", required: true, sample: "DEP-01" },
      { key: "department_name", label: "Department Name", required: true, sample: "Engineering" },
      { key: "description", label: "Description", sample: "" },
      { key: "status", label: "Status", default: "Active", sample: "Active" },
    ],
  },
  "hr-designations": {
    table: "hr_designations",
    createdBy: null,
    columns: [
      { key: "designation_id", label: "Designation ID", required: true, sample: "DES-01" },
      { key: "designation_name", label: "Designation Name", required: true, sample: "Software Engineer" },
      { key: "level_name", label: "Level", sample: "L2" },
      { key: "description", label: "Description", sample: "" },
      { key: "status", label: "Status", default: "Active", sample: "Active" },
    ],
  },
} satisfies Record<string, ImportConfig>)
