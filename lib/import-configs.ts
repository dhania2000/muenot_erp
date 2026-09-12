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

import type { ModuleConfig, FieldType } from "@/lib/finance-schema"
import { RECRUITMENT_MODULE_CONFIGS } from "@/lib/recruitment-module-configs"
import { FINANCE_MODULE_CONFIGS } from "@/lib/finance-module-configs"

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
    createdBy: "created_by",
    // Shift IDs are minted server-side (SHIFT-0001…) via the shared sequence, so
    // they are never carried in the spreadsheet — matching the manual form.
    idColumn: "shift_id",
    id: { strategy: "sequence", prefix: "SHIFT" },
    // working_hours is a NOT NULL derived column; seed it so imports never fail.
    // Admins can refine timing later by editing the shift, which recomputes it.
    defaults: { working_hours: 0 },
    columns: [
      { key: "shift_code", label: "Shift Code", aliases: ["code"], sample: "GEN" },
      { key: "shift_name", label: "Shift Name", required: true, sample: "General" },
      { key: "start_time", label: "Start Time", required: true, sample: "09:00" },
      { key: "end_time", label: "End Time", required: true, sample: "18:00" },
      { key: "is_overnight", label: "Overnight", type: "number", default: 0, sample: "0" },
      { key: "break_minutes", label: "Break Minutes", type: "number", default: 0, sample: "60" },
      { key: "grace_minutes", label: "Grace Minutes", type: "number", default: 10, sample: "10" },
      { key: "late_enabled", label: "Late Tracking", type: "number", default: 1, sample: "1" },
      { key: "early_checkout_enabled", label: "Early Checkout Rule", type: "number", default: 1, sample: "1" },
      { key: "early_grace_minutes", label: "Early Grace Minutes", type: "number", default: 10, sample: "10" },
      { key: "overtime_enabled", label: "Overtime Enabled", type: "number", default: 0, sample: "0" },
      { key: "overtime_eligible", label: "Overtime Eligible", type: "number", default: 1, sample: "1" },
      { key: "overtime_threshold_minutes", label: "Overtime Threshold", type: "number", default: 0, sample: "0" },
      { key: "overtime_rounding_minutes", label: "Overtime Rounding", type: "number", default: 0, sample: "0" },
      { key: "working_days", label: "Working Days", aliases: ["workdays"], sample: "1,2,3,4,5" },
      { key: "weekly_offs", label: "Weekly Offs", aliases: ["weeklyoff"], sample: "0,6" },
      { key: "effective_from", label: "Effective From", type: "date", sample: "2025-01-01" },
      { key: "effective_until", label: "Effective Until", type: "date", sample: "" },
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
      { key: "accrual_method", label: "Accrual Method", default: "Annual", sample: "Annual" },
      { key: "prorate_on_join", label: "Prorate On Join", type: "number", default: 1, sample: "1" },
      { key: "allow_negative", label: "Allow Negative", type: "number", default: 0, sample: "0" },
      { key: "low_balance_threshold", label: "Low Balance Threshold", type: "number", default: 0, sample: "0" },
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
      { key: "carry_forward", label: "Carry Forward", type: "number", default: 0, sample: "0" },
      { key: "expired", label: "Expired", type: "number", default: 0, sample: "0" },
    ],
  },
  "hr-leave-quota-history": {
    table: "hr_leave_quota_history",
    createdBy: "created_by",
    // Imported rows are stamped so they are clearly distinguishable from
    // system-generated ledger events. quota_event_id is assigned by the engine.
    defaults: { source: "Import" },
    columns: [
      { key: "employee_id", label: "Employee ID", type: "number", required: true, sample: "101" },
      { key: "leave_type_id", label: "Leave Type ID", type: "number", required: true, sample: "1" },
      { key: "year", label: "Year", type: "number", required: true, sample: "2025" },
      { key: "event_type", label: "Event Type", required: true, sample: "adjustment" },
      { key: "days", label: "Days", type: "number", required: true, sample: "2" },
      { key: "reference", label: "Reference", sample: "LADJ-2026-000001" },
      { key: "reason", label: "Reason", required: true, sample: "Historical adjustment" },
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

/* ------------------------------------------------------------------ *
 * Config-driven modules (Recruit + Finance)
 *
 * The Recruitment and Finance families already describe every column, its
 * type, and its id strategy in their ModuleConfig definitions. Rather than
 * restate all of that here, we derive an ImportConfig from each ModuleConfig
 * so one source of truth drives both the CRUD screens and the bulk importer.
 * ------------------------------------------------------------------ */

function importTypeForField(type: FieldType): ImportColumnType {
  if (type === "number" || type === "checkbox") return "number"
  if (type === "date") return "date"
  return "string"
}

function moduleConfigToImportConfig(cfg: ModuleConfig): ImportConfig {
  // Auto-generated ids are minted server-side; hand-entered (manual) ids must
  // travel in the spreadsheet, so only the auto case is excluded from columns.
  const autoId = !cfg.manualId && !!cfg.idPrefix
  const columns: ImportColumn[] = []

  for (const f of cfg.fields) {
    if (f.computed) continue // derived server-side; never imported
    if (autoId && f.key === cfg.idColumn) continue // minted on insert, not imported

    const col: ImportColumn = { key: f.key, label: f.label, type: importTypeForField(f.type) }
    if (f.required || (cfg.manualId && f.key === cfg.idColumn)) col.required = true
    if (f.type === "checkbox") col.default = 0 // NOT NULL tinyint flags settle to 0
    columns.push(col)
  }

  const config: ImportConfig = { table: cfg.table, columns }
  if (autoId) {
    config.idColumn = cfg.idColumn
    // Shares the record_id_sequences counter with the CRUD factory, so imported
    // and hand-created ids never collide. allowCustom lets newer prefixes that
    // aren't in the built-in whitelist through.
    config.id = { strategy: "sequence", prefix: cfg.idPrefix as string, allowCustom: true }
  }
  return config
}

// Recruit: every config-driven recruitment sub-module (keyed "recruit-<key>").
for (const cfg of Object.values(RECRUITMENT_MODULE_CONFIGS)) {
  IMPORT_CONFIGS[`recruit-${cfg.key}`] = moduleConfigToImportConfig(cfg)
}

// Finance: every config-driven module that doesn't already ship a bespoke
// importer (bank-transactions has its own statement-import dialog).
for (const cfg of Object.values(FINANCE_MODULE_CONFIGS)) {
  if (cfg.importSpec) continue
  IMPORT_CONFIGS[`finance-${cfg.key}`] = moduleConfigToImportConfig(cfg)
}

/* ------------------------------------------------------------------ *
 * Operations (delivery cockpit)
 *
 * Operations records live in AUTO_INCREMENT-keyed tables with no created_by
 * column, so these configs mint no id and stamp no user. Columns mirror the
 * writable set accepted by /api/operations.
 * ------------------------------------------------------------------ */
const OP_NUMERIC = new Set([
  "capacity_hours", "cost_rate", "required_resources", "allocated_resources", "resources_deficiency",
  "allocation_percent", "working_capacity", "allocated_capacity", "available_capacity",
  "quality_score", "quality_target", "error_rate", "rework_count", "sla_actual", "sla_score",
])

function opColumns(fields: string[], required: string[] = []): ImportColumn[] {
  return fields.map((key) => {
    const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    const type: ImportColumnType = key.includes("date") ? "date" : OP_NUMERIC.has(key) ? "number" : "string"
    const col: ImportColumn = { key, label, type }
    if (required.includes(key)) col.required = true
    return col
  })
}

Object.assign(IMPORT_CONFIGS, {
  "operations-resources": {
    table: "operations_resources",
    createdBy: null,
    columns: opColumns(
      ["employee_id", "resource_name", "resource_type", "department", "designation", "skill_category", "primary_skills", "secondary_skills", "skill_set", "capacity_hours", "employment_status", "joining_date", "exit_date", "current_location", "work_mode", "availability_status", "cost_rate", "rate_type", "reporting_manager", "personal_email", "official_email", "contact_mobile", "vendor_agency", "shift", "status", "notes", "remarks"],
      ["resource_name"],
    ),
  },
  "operations-projects": {
    table: "operations_projects",
    createdBy: null,
    columns: opColumns(
      ["project_name", "client_id", "client_name", "service_vertical", "project_type", "project_manager", "operations_manager", "manager_name", "start_date", "end_date", "status", "billing_model", "required_resources", "allocated_resources", "resources_deficiency", "sla_target", "sla_due_date", "priority", "shift", "work_mode", "client_poc", "client_email", "client_contact", "description", "remarks"],
      ["project_name"],
    ),
  },
  "operations-allocations": {
    table: "operations_allocations",
    createdBy: null,
    columns: opColumns(
      ["project_id", "client_name", "resource_id", "resource_name", "resource_type", "role", "allocation_percent", "from_date", "to_date", "shift", "working_capacity", "allocated_capacity", "available_capacity", "status", "project_manager", "operations_manager", "assigned_by", "notes", "remarks"],
      ["resource_name"],
    ),
  },
  "operations-quality": {
    table: "operations_quality_reviews",
    createdBy: null,
    columns: opColumns(
      ["task_id", "project_id", "client_name", "resource_id", "resource_name", "resource_type", "review_date", "quality_score", "quality_target", "error_rate", "rework_count", "sla_target", "sla_actual", "sla_score", "sla_status", "client_escalation", "root_cause", "corrective_action", "action_owner", "action_due_date", "closure_date", "status", "reviewer_name", "remarks"],
      ["review_date"],
    ),
  },
  "operations-issues": {
    table: "operations_issues",
    createdBy: null,
    columns: opColumns(
      ["date_reported", "project_id", "client_name", "issue_type", "issue_category", "priority", "title", "description", "impact", "reported_by", "assigned_to", "root_cause", "corrective_action", "preventive_action", "target_date", "due_date", "closure_date", "status", "escalation_level", "client_impact", "business_impact", "remarks"],
      ["date_reported"],
    ),
  },
} satisfies Record<string, ImportConfig>)

/* ------------------------------------------------------------------ *
 * Shared masters (used across modules)
 * ------------------------------------------------------------------ */
Object.assign(IMPORT_CONFIGS, {
  clients: {
    table: "clients",
    feature: "clients.manage_clients",
    idColumn: "client_code",
    id: { strategy: "sequence", prefix: "CLI" },
    columns: [
      { key: "salutation", label: "Salutation", sample: "Mr" },
      { key: "client_name", label: "Client Name", required: true, sample: "Jane Doe" },
      { key: "email", label: "Email", required: true, sample: "jane@acme.com" },
      { key: "mobile", label: "Mobile", sample: "9876543210" },
      { key: "gender", label: "Gender", sample: "Female" },
      { key: "language", label: "Language", sample: "English" },
      { key: "company_name", label: "Company Name", sample: "Acme Corp" },
      { key: "website", label: "Website", sample: "https://acme.com" },
      { key: "tax_name", label: "Tax Name", sample: "" },
      { key: "gst_number", label: "GST/VAT Number", sample: "" },
      { key: "office_phone", label: "Office Phone", sample: "" },
      { key: "address", label: "Address", sample: "" },
      { key: "city", label: "City", sample: "Mumbai" },
      { key: "state", label: "State", sample: "MH" },
      { key: "country", label: "Country", sample: "India" },
      { key: "postal_code", label: "Postal Code", sample: "400001" },
      { key: "category", label: "Category", sample: "" },
      { key: "sub_category", label: "Sub Category", sample: "" },
      { key: "currency", label: "Currency", sample: "INR" },
      { key: "login_allowed", label: "Login Allowed", default: "No", sample: "No" },
      { key: "email_notifications", label: "Email Notifications", default: "Yes", sample: "Yes" },
      { key: "status", label: "Status", default: "Active", sample: "Active" },
      { key: "notes", label: "Notes", sample: "" },
    ],
  },
  "finance-sales-invoices": {
    table: "sales_invoices",
    idColumn: "invoice_id",
    id: { strategy: "sequence", prefix: "INV", allowCustom: true },
    columns: [
      { key: "invoice_date", label: "Invoice Date", type: "date", default: "@today", sample: "2025-01-15" },
      { key: "invoice_type", label: "Invoice Type", default: "Tax Invoice", sample: "Tax Invoice" },
      { key: "financial_year", label: "Financial Year", sample: "2024-25" },
      { key: "client_id", label: "Client ID", sample: "CLI-0001" },
      { key: "client_name", label: "Client", required: true, sample: "Acme Corp" },
      { key: "project_id", label: "Project ID", sample: "" },
      { key: "project_name", label: "Project", sample: "" },
      { key: "billing_period_from", label: "Billing From", type: "date", sample: "" },
      { key: "billing_period_to", label: "Billing To", type: "date", sample: "" },
      { key: "description", label: "Description", sample: "" },
      { key: "hsn_sac", label: "HSN/SAC", sample: "" },
      { key: "quantity", label: "Quantity", type: "number", default: 0, sample: "1" },
      { key: "unit", label: "Unit", sample: "" },
      { key: "rate", label: "Rate", type: "number", default: 0, sample: "100000" },
      { key: "taxable_amount", label: "Taxable Amount", type: "number", default: 0, sample: "100000" },
      { key: "discount", label: "Discount", type: "number", default: 0, sample: "0" },
      { key: "cgst_percent", label: "CGST %", type: "number", default: 0, sample: "9" },
      { key: "cgst_amount", label: "CGST Amount", type: "number", default: 0, sample: "9000" },
      { key: "sgst_percent", label: "SGST %", type: "number", default: 0, sample: "9" },
      { key: "sgst_amount", label: "SGST Amount", type: "number", default: 0, sample: "9000" },
      { key: "igst_percent", label: "IGST %", type: "number", default: 0, sample: "0" },
      { key: "igst_amount", label: "IGST Amount", type: "number", default: 0, sample: "0" },
      { key: "other_tax_cess", label: "Other Tax/Cess", type: "number", default: 0, sample: "0" },
      { key: "invoice_total", label: "Invoice Total", type: "number", default: 0, sample: "118000" },
      { key: "tds_applicable", label: "TDS Applicable", type: "number", default: 0, sample: "0" },
      { key: "tds_section", label: "TDS Section", sample: "" },
      { key: "tds_rate", label: "TDS Rate", type: "number", default: 0, sample: "0" },
      { key: "tds_amount", label: "TDS Amount", type: "number", default: 0, sample: "0" },
      { key: "net_receivable", label: "Net Receivable", type: "number", default: 0, sample: "118000" },
      { key: "due_date", label: "Due Date", type: "date", sample: "2025-02-15" },
      { key: "amount_received", label: "Amount Received", type: "number", default: 0, sample: "0" },
      { key: "outstanding_amount", label: "Outstanding", type: "number", default: 0, sample: "118000" },
      { key: "payment_status", label: "Payment Status", default: "Unpaid", sample: "Unpaid" },
      { key: "payment_date", label: "Payment Date", type: "date", sample: "" },
      { key: "payment_reference", label: "Payment Reference", sample: "" },
      { key: "irn_reference", label: "IRN Reference", sample: "" },
      { key: "eway_bill_no", label: "E-Way Bill No", sample: "" },
      { key: "credit_debit_note_ref", label: "Credit/Debit Note Ref", sample: "" },
      { key: "notes", label: "Notes", sample: "" },
      { key: "invoice_status", label: "Invoice Status", default: "Draft", sample: "Draft" },
    ],
  },
} satisfies Record<string, ImportConfig>)
