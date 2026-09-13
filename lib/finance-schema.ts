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
  /**
   * Stored + shown in the detail view, but never rendered as an editable input
   * in the create/edit form. Used for server-populated snapshots (e.g. GSTIN
   * verification metadata) that the user should not hand-edit.
   */
  hidden?: boolean
  /** Seed value for new records (used for fixed fields such as party_type). */
  default?: string
}

/**
 * Optional GSTIN verification capability for a master module (the Vendor
 * master). When present, the form renders a dedicated GSTIN block that calls
 * the lookup endpoint, autofills empty fields from the GST network snapshot,
 * flags conflicts and duplicates, and stores the verification metadata.
 */
export type GstinVerifyConfig = {
  /** Column holding the GSTIN (e.g. "gstin"). */
  column: string
  /** Server route that verifies + returns autofill/meta/duplicate payloads. */
  lookupPath: string
  /** Map of GST-network snapshot keys -> module field keys to autofill. */
  autofill: { name?: string; legalName?: string; pan?: string; address?: string; state?: string }
  /** Field key that receives the authoritative verification status string. */
  statusField: string
}

/**
 * Optional IFSC lookup capability for a master module (the Vendor master's
 * banking block). When present, the form resolves the bank name and branch from
 * the entered IFSC via the lookup endpoint and fills the mapped fields.
 */
export type IfscLookupConfig = {
  /** Column holding the IFSC (e.g. "ifsc"). */
  column: string
  /** Server route that resolves an IFSC to bank/branch details. */
  lookupPath: string
  /** Map of resolved keys -> module field keys to autofill. */
  autofill: { bank?: string; branch?: string }
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

/** A single column recognised by the statement / spreadsheet importer. */
export type ImportColumn = {
  /** Canonical column key in the module's table. */
  key: string
  /** Human label shown in the mapping/preview UI and template header. */
  label: string
  /** Normalized header aliases (lowercase, alphanumeric only) matched in the upload. */
  aliases: string[]
  type?: "date" | "number" | "text"
  required?: boolean
}

/** Optional bulk-import capability for a module (e.g. bank statement upload). */
export type ImportSpec = {
  title: string
  description: string
  /** Filename used for the downloadable starter template. */
  templateName: string
  /**
   * When true the importer asks the user to pick a bank/cash account first and
   * stamps every imported row with that account (account_name + id).
   */
  accountBound?: boolean
  columns: ImportColumn[]
}

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
  /** Enables the "Import" action and drives the bulk upload mapping. */
  importSpec?: ImportSpec
  /**
   * Enables per-row invoice actions (Download PDF + Send by email). Only the
   * Freelance Invoices module uses this today; the endpoints live under
   * /api/finance/freelance-invoices/[id].
   */
  invoiceActions?: boolean
  /**
   * Base API path that serves a per-row invoice PDF at `${pdfPath}/${row.id}/pdf`.
   * When set, the module list renders a "Download PDF" action per row.
   */
  pdfPath?: string
  /**
   * Field key holding the recipient email, used to pre-fill the "Send by email"
   * dialog (e.g. "freelancer_email" for Freelance, "employee_email" for FTE).
   */
  emailField?: string
  /**
   * When set, the list's per-row "View" action navigates to a dedicated detail
   * page at `${detailPath}/${row[idColumn]}` (e.g. the Vendor 360 view) instead
   * of opening the inline detail dialog.
   */
  detailPath?: string
  /** Optional GSTIN verification capability (Vendor master). */
  gstin?: GstinVerifyConfig
  /** Optional IFSC → bank/branch autofill capability (Vendor master). */
  ifsc?: IfscLookupConfig
  /**
   * Extra SELECT expressions appended to the list query (aliased on `x`), used
   * for derived columns that live in another table — e.g. the Vendor list's
   * outstanding total computed from purchase_bills. Must be a safe, static SQL
   * fragment (never interpolated from user input).
   */
  extraSelect?: string
  /**
   * Optional party (vendor) picker rendered at the top of the create/edit form.
   * Selecting a party fills the id + name fields and copies the mapped master
   * columns into the form (empty fields only), e.g. a Purchase Bill inheriting
   * the vendor's TDS defaults and payment terms.
   */
  partyLookup?: PartyLookupConfig
}

/**
 * Config for the in-form party picker. `sourceKey` is another finance module
 * whose list endpoint supplies the options (e.g. "customers-vendors"). `autofill`
 * maps source columns -> this module's field keys.
 */
export type PartyLookupConfig = {
  /** Module key whose `/api/finance/module/<key>` list feeds the picker. */
  sourceKey: string
  /** Field that receives the party's business id (e.g. "vendor_id"). */
  idField: string
  /** Field that receives the party's display name (e.g. "vendor_name"). */
  nameField: string
  /** Source column holding the business id (e.g. "party_id"). */
  sourceIdColumn: string
  /** Source column holding the display name (e.g. "customer_name"). */
  sourceNameColumn: string
  /** Map of source column -> this module's field key, filled when empty. */
  autofill: Record<string, string>
  /** Label for the picker block. */
  label: string
}
