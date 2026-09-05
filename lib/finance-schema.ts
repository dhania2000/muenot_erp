/**
 * Type definitions for the config-driven Finance modules. Each module is
 * described once by a ModuleConfig; the server CRUD factory, the generic
 * list client, and the generic form dialog are all driven by that config.
 */

export type FieldType = "text" | "number" | "date" | "textarea" | "select" | "checkbox"

export type FieldDef = {
  section: string
  key: string
  label: string
  type: FieldType
  options?: string[]
  placeholder?: string
  required?: boolean
  /** Derived on the server — rendered read-only in the computed summary box. */
  computed?: boolean
  /** Format the value as currency in tables, details and the computed box. */
  money?: boolean
  /** Optional select: renders an empty choice. */
  optional?: boolean
  emptyLabel?: string
}

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline"

export type TableColumn = {
  key: string
  label: string
  align?: "left" | "right"
  money?: boolean
  mono?: boolean
  /** Secondary line shown under the main value. */
  sub?: string
  /** Render as a Badge, mapping value -> variant. */
  badge?: Record<string, BadgeVariant>
}

export type Kpi = { label: string; key: string; money?: boolean; icon?: string }

export type FilterDef =
  | { type: "search"; key: "search"; placeholder: string }
  | { type: "select"; key: string; label: string; options: string[] }
  | { type: "financial_year"; key: "financial_year"; label: string }
  | { type: "month"; key: "month"; label: string }
  | { type: "date_from"; key: "date_from" }
  | { type: "date_to"; key: "date_to" }

export type ModuleConfig = {
  key: string
  table: string
  label: string
  subtitle: string
  addLabel: string
  idColumn: string
  /** null => manual entry (e.g. Purchase Bill PO Number). */
  idPrefix: string | null
  manualId?: boolean
  /**
   * The id column is shown in the form and may be entered by hand, but when the
   * user leaves it blank it is auto-generated from idPrefix on create. Lets a
   * module keep a real business key (e.g. a PO Number) while still guaranteeing
   * every record gets an id automatically.
   */
  editableId?: boolean
  /** System tracking fields (tracking_id / opened / open_count) generated on create. */
  trackingId?: boolean
  dateColumn?: string
  financialYearColumn?: string
  statusColumn?: string
  searchColumns: string[]
  /** Extra column-backed filters exposed by the CRUD factory's WHERE builder. */
  filters?: FilterDef[]
  fields: FieldDef[]
  compute?: (v: Record<string, any>) => Record<string, any>
  tableColumns: TableColumn[]
  kpis: Kpi[]
  /** SQL aggregate list whose aliases match kpi.key values. */
  summarySelect: string
}
