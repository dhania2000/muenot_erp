import type { LookupKind } from "./lookup-select"

// ---------------------------------------------------------------------------
// Declarative per-master field + column configuration.
//
// Drives both the create/edit forms (widget type, required, admin-only) and the
// list table (label, formatting) so the master-data client renders proper
// domain UI instead of raw text boxes. IDs/codes are display-only (server owns
// generation), so they are never form inputs.
// ---------------------------------------------------------------------------

export type FieldType = "text" | "textarea" | "date" | "number" | "select" | "checkbox" | "lookup" | "currency"

export type FieldDef = {
  name: string
  label: string
  type: FieldType
  options?: string[]
  lookup?: LookupKind
  required?: boolean
  adminOnly?: boolean
  /** Editable after creation? Defaults to true. */
  editable?: boolean
  /** Show as a table column? Defaults to true. */
  column?: boolean
  /** Only in the table, never in the form (server-derived like codes). */
  displayOnly?: boolean
  /** Full-width in the form grid. */
  wide?: boolean
}

export type MasterMeta = {
  label: string
  singular: string
  idKey: string
  /** The human display-code column shown as the first table column. */
  codeKey: string
  fields: FieldDef[]
  /** Fields used by the free-text search box. */
  searchKeys: string[]
  hasStatus: boolean
}

const STATUS = ["Active", "Inactive"]

export const MASTER_META: Record<string, MasterMeta> = {
  departments: {
    label: "Departments",
    singular: "Department",
    idKey: "department_id",
    codeKey: "department_id",
    hasStatus: true,
    searchKeys: ["department_id", "department_name"],
    fields: [
      { name: "department_id", label: "ID", type: "text", displayOnly: true },
      { name: "department_name", label: "Department Name", type: "text", required: true },
      { name: "parent_department_id", label: "Parent Department", type: "lookup", lookup: "departments" },
      { name: "head_employee_id", label: "Department Head", type: "lookup", lookup: "employees" },
      { name: "description", label: "Description", type: "textarea", column: false, wide: true },
      { name: "status", label: "Status", type: "select", options: STATUS },
    ],
  },
  designations: {
    label: "Designations",
    singular: "Designation",
    idKey: "designation_id",
    codeKey: "designation_id",
    hasStatus: true,
    searchKeys: ["designation_id", "designation_name", "level_name"],
    fields: [
      { name: "designation_id", label: "ID", type: "text", displayOnly: true },
      { name: "designation_name", label: "Designation Name", type: "text", required: true },
      { name: "parent_designation_id", label: "Reports To", type: "lookup", lookup: "designations" },
      { name: "level_name", label: "Level / Grade", type: "text" },
      { name: "description", label: "Description", type: "textarea", column: false, wide: true },
      { name: "status", label: "Status", type: "select", options: STATUS },
    ],
  },
  holidays: {
    label: "Holidays",
    singular: "Holiday",
    idKey: "holiday_id",
    codeKey: "holiday_code",
    hasStatus: true,
    searchKeys: ["holiday_code", "holiday_name", "applicable_state_ut"],
    fields: [
      { name: "holiday_code", label: "Code", type: "text", displayOnly: true },
      { name: "holiday_name", label: "Holiday Name", type: "text", required: true },
      { name: "holiday_date", label: "Date", type: "date", required: true },
      {
        name: "holiday_type",
        label: "Type",
        type: "select",
        options: ["National", "Regional", "Company", "Restricted"],
      },
      { name: "applicable_department_id", label: "Department (optional)", type: "lookup", lookup: "departments" },
      { name: "applicable_state_ut", label: "State / UT", type: "text" },
      { name: "optional", label: "Optional / Floating", type: "checkbox" },
      { name: "description", label: "Description", type: "textarea", column: false, wide: true },
      { name: "status", label: "Status", type: "select", options: STATUS },
    ],
  },
  promotions: {
    label: "Promotions",
    singular: "Promotion",
    idKey: "promotion_id",
    codeKey: "promotion_code",
    hasStatus: true,
    searchKeys: ["promotion_code", "employee_name"],
    fields: [
      { name: "promotion_code", label: "Code", type: "text", displayOnly: true },
      { name: "employee_name", label: "Employee", type: "text", displayOnly: true },
      { name: "employee_id", label: "Employee", type: "lookup", lookup: "employees", required: true, editable: false, column: false },
      { name: "effective_date", label: "Effective Date", type: "date", required: true },
      { name: "new_designation_id", label: "New Designation", type: "lookup", lookup: "designations" },
      { name: "new_department_id", label: "New Department", type: "lookup", lookup: "departments" },
      { name: "new_grade", label: "New Grade", type: "text" },
      { name: "new_salary", label: "New Salary", type: "currency", adminOnly: true },
      { name: "reason", label: "Reason", type: "textarea", required: true, column: false, wide: true },
      { name: "status", label: "Status", type: "select", options: ["Pending", "Approved", "Rejected"] },
      { name: "approver_name", label: "Approved By", type: "text", displayOnly: true },
    ],
  },
  awards: {
    label: "Awards",
    singular: "Award",
    idKey: "award_id",
    codeKey: "award_code",
    hasStatus: true,
    searchKeys: ["award_code", "award_name", "employee_name"],
    fields: [
      { name: "award_code", label: "Code", type: "text", displayOnly: true },
      { name: "employee_name", label: "Employee", type: "text", displayOnly: true },
      { name: "employee_id", label: "Employee", type: "lookup", lookup: "employees", required: true, editable: false, column: false },
      { name: "award_name", label: "Award", type: "text", required: true },
      { name: "award_date", label: "Date", type: "date", required: true },
      { name: "description", label: "Description", type: "textarea", column: false, wide: true },
      { name: "badge_url", label: "Badge URL", type: "text", column: false },
      { name: "status", label: "Status", type: "select", options: STATUS },
    ],
  },
  appreciations: {
    label: "Appreciations",
    singular: "Appreciation",
    idKey: "appreciation_id",
    codeKey: "appreciation_code",
    hasStatus: true,
    searchKeys: ["appreciation_code", "title", "employee_name"],
    fields: [
      { name: "appreciation_code", label: "Code", type: "text", displayOnly: true },
      { name: "employee_name", label: "Employee", type: "text", displayOnly: true },
      { name: "employee_id", label: "Employee", type: "lookup", lookup: "employees", required: true, editable: false, column: false },
      { name: "title", label: "Title", type: "text", required: true },
      { name: "message", label: "Message", type: "textarea", required: true, column: false, wide: true },
      { name: "category", label: "Category", type: "text" },
      { name: "appreciation_date", label: "Date", type: "date" },
      { name: "status", label: "Status", type: "select", options: STATUS },
    ],
  },
  "passport-visa": {
    label: "Passport / Visa",
    singular: "Record",
    idKey: "record_id",
    codeKey: "pv_code",
    hasStatus: true,
    searchKeys: ["pv_code", "employee_name", "passport_number", "country"],
    fields: [
      { name: "pv_code", label: "Code", type: "text", displayOnly: true },
      { name: "employee_name", label: "Employee", type: "text", displayOnly: true },
      { name: "employee_id", label: "Employee", type: "lookup", lookup: "employees", required: true, editable: false, column: false },
      { name: "passport_number", label: "Passport No.", type: "text" },
      { name: "passport_issue_date", label: "Passport Issue", type: "date", column: false },
      { name: "passport_expiry_date", label: "Passport Expiry", type: "date" },
      { name: "visa_type", label: "Visa Type", type: "text" },
      { name: "visa_number", label: "Visa No.", type: "text", column: false },
      { name: "visa_issue_date", label: "Visa Issue", type: "date", column: false },
      { name: "visa_expiry_date", label: "Visa Expiry", type: "date" },
      { name: "country", label: "Country", type: "text" },
      { name: "remarks", label: "Remarks", type: "textarea", column: false, wide: true },
      { name: "status", label: "Status", type: "select", options: STATUS },
    ],
  },
}

export function formatCell(field: FieldDef, value: any): string {
  if (value === null || value === undefined || value === "") return "—"
  if (field.type === "checkbox") return value ? "Yes" : "No"
  if (field.type === "currency") {
    const n = Number(value)
    return Number.isFinite(n) ? n.toLocaleString(undefined, { style: "currency", currency: "INR" }) : String(value)
  }
  if (field.type === "date") {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString()
  }
  return String(value)
}
