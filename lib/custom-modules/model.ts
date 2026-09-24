/**
 * SPEC 96 — Custom Module Framework: pure model (Phase 1 & 2).
 * ---------------------------------------------------------------------------
 * The metadata-driven, dependency-free core of the tenant-created custom-module
 * engine. It holds ZERO database access and no "server-only" marker so the SAME
 * rules drive the admin builder, the browser renderer, the API and the server,
 * and can be unit-tested exhaustively without a live DB (see
 * test/custom-modules-model.test.ts).
 *
 * A custom module is DATA, not code. A tenant describes an entirely new
 * lightweight entity — its name, the fields its records carry, the columns its
 * list view shows, who may view/create/edit/delete its records, the workflow
 * states records move through, the reports summarising them and whether records
 * accept attachments — and the engine turns that description into storage,
 * validation, a record CRUD + workflow API, list views and reporting. Nothing
 * about a module is hard-coded.
 *
 * Deliberately reuses the SPEC 94 custom-FIELD engine for field types, value
 * validation and the safe formula parser, so a module's fields behave exactly
 * like the custom fields that extend the built-in modules.
 */
import {
  type FieldConfig,
  type FieldDefinition,
  type FieldOption,
  type FieldType,
  FIELD_TYPES,
  checkFormula,
  evaluateFormula,
  getFieldTypeDef,
  keyFromLabel,
  normalizeFieldKey,
  numericValueOf,
  validateFieldValue,
} from "@/lib/custom-fields/model"
import { type TenantRole, tenantRank, toTenantRole } from "@/lib/role-model"

export type { FieldType, FieldOption, FieldConfig } from "@/lib/custom-fields/model"
export { FIELD_TYPES, getFieldTypeDef, numericValueOf, evaluateFormula } from "@/lib/custom-fields/model"

// ---------------------------------------------------------------------------
// Slug + name normalization
// ---------------------------------------------------------------------------

/** A module slug: lowercase, alnum + hyphen, never leading digit. */
export function normalizeSlug(raw: string): string {
  let s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (s && /^[0-9]/.test(s)) s = `m-${s}`
  return s.slice(0, 60)
}

export function slugFromName(name: string): string {
  return normalizeSlug(name)
}

function localNormalizeOptions(raw: unknown): FieldOption[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: FieldOption[] = []
  for (const item of raw) {
    let value = ""
    let label = ""
    if (typeof item === "string") {
      value = item.trim()
      label = value
    } else if (item && typeof item === "object") {
      value = String((item as any).value ?? "").trim()
      label = String((item as any).label ?? value).trim()
    }
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push({ value, label: label || value })
  }
  return out
}

function clampInt(value: unknown, lo: number, hi: number): number | null {
  if (value == null || value === "") return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(lo, Math.min(hi, Math.trunc(n)))
}

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// Module field
// ---------------------------------------------------------------------------

export type ModuleField = {
  key: string
  label: string
  type: FieldType
  required: boolean
  options: FieldOption[]
  config: FieldConfig
  helpText: string
  /** Show this field as a column in the module's list view. */
  showInList: boolean
  sortOrder: number
}

export type ModuleFieldInput = {
  key?: string
  label: string
  type: string
  required?: boolean
  options?: unknown
  config?: Partial<FieldConfig>
  helpText?: string
  showInList?: boolean
  sortOrder?: number
}

/**
 * Adapt a ModuleField into the custom-fields FieldDefinition shape so record
 * values run through the exact same validation the built-in modules use. The
 * entityType is informational only here (validateFieldValue never checks it).
 */
export function toFieldDefinition(slug: string, field: ModuleField): FieldDefinition {
  return {
    entityType: `custom:${slug}`,
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    options: field.options,
    config: field.config,
    defaultValue: null,
    helpText: field.helpText,
    viewMinRole: "employee",
    editMinRole: "employee",
    active: true,
    sortOrder: field.sortOrder,
  }
}

/**
 * Validate + normalize one raw field into a ModuleField, or collect reasons.
 * `siblingNumericKeys` are the module's OTHER numeric field keys, needed to
 * validate a formula's references.
 */
export function validateModuleField(
  input: ModuleFieldInput,
  siblingNumericKeys: readonly string[] = [],
): { ok: true; field: ModuleField } | { ok: false; errors: string[] } {
  const errors: string[] = []

  const label = String(input.label ?? "").trim()
  if (!label) errors.push("A field label is required.")

  const type = String(input.type ?? "")
  const typeDef = getFieldTypeDef(type)
  if (!typeDef) errors.push(`Field type must be one of: ${FIELD_TYPES.map((t) => t.type).join(", ")}.`)

  const key = normalizeFieldKey(input.key || keyFromLabel(label))
  if (!key) errors.push("Could not derive a valid field key from the label.")
  if (key.length > 60) errors.push("Field key must be 60 characters or fewer.")

  const options = localNormalizeOptions(input.options)
  const config: FieldConfig = {}

  if (typeDef) {
    if (typeDef.hasOptions) {
      if (options.length === 0) errors.push(`${typeDef.label} fields need at least one option.`)
      if (options.length > 200) errors.push("A field may not have more than 200 options.")
    }

    if (typeDef.type === "entity") {
      const target = String(input.config?.targetEntity ?? "").trim()
      if (!target) errors.push("An entity field must name the entity it points to.")
      else config.targetEntity = target
    }

    if (typeDef.type === "number" || typeDef.type === "currency") {
      config.min = toNum(input.config?.min)
      config.max = toNum(input.config?.max)
      config.precision = clampInt(input.config?.precision, 0, 6)
      if (config.min != null && config.max != null && config.min > config.max) {
        errors.push("Minimum cannot be greater than maximum.")
      }
      if (typeDef.type === "currency") {
        const code = String(input.config?.currencyCode ?? "USD").trim().toUpperCase()
        if (!/^[A-Z]{3}$/.test(code)) errors.push("Currency code must be a 3-letter ISO code.")
        else config.currencyCode = code
      }
    }

    if (typeDef.type === "text") {
      config.max = clampInt(input.config?.max, 1, 10000)
    }

    if (typeDef.type === "formula") {
      const check = checkFormula(String(input.config?.formula ?? ""), siblingNumericKeys)
      if (!check.ok) errors.push(check.error)
      else {
        if (check.refs.includes(key)) errors.push("A formula cannot reference itself.")
        config.formula = String(input.config?.formula ?? "").trim()
      }
    }
  }

  const required = typeDef?.computed ? false : input.required === true

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    field: {
      key,
      label,
      type: type as FieldType,
      required,
      options: typeDef!.hasOptions ? options : [],
      config,
      helpText: String(input.helpText ?? "").trim(),
      showInList: input.showInList === true,
      sortOrder: Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type ModulePermissions = {
  viewMinRole: TenantRole
  createMinRole: TenantRole
  editMinRole: TenantRole
  deleteMinRole: TenantRole
}

export const DEFAULT_PERMISSIONS: ModulePermissions = {
  viewMinRole: "employee",
  createMinRole: "employee",
  editMinRole: "employee",
  deleteMinRole: "tenant_admin",
}

function normalizePermissions(raw: Partial<Record<keyof ModulePermissions, unknown>> | undefined): {
  perms: ModulePermissions
  errors: string[]
} {
  const errors: string[] = []
  const perms: ModulePermissions = {
    viewMinRole: toTenantRole(raw?.viewMinRole ?? DEFAULT_PERMISSIONS.viewMinRole),
    createMinRole: toTenantRole(raw?.createMinRole ?? DEFAULT_PERMISSIONS.createMinRole),
    editMinRole: toTenantRole(raw?.editMinRole ?? DEFAULT_PERMISSIONS.editMinRole),
    deleteMinRole: toTenantRole(raw?.deleteMinRole ?? DEFAULT_PERMISSIONS.deleteMinRole),
  }
  // Fail-safe ordering: you can never create/edit a record you can't view.
  if (tenantRank(perms.createMinRole) < tenantRank(perms.viewMinRole)) {
    errors.push("Create access cannot be broader than view access.")
  }
  if (tenantRank(perms.editMinRole) < tenantRank(perms.viewMinRole)) {
    errors.push("Edit access cannot be broader than view access.")
  }
  if (tenantRank(perms.deleteMinRole) < tenantRank(perms.editMinRole)) {
    errors.push("Delete access cannot be broader than edit access.")
  }
  return { perms, errors }
}

export function canViewModule(perms: ModulePermissions, role: TenantRole): boolean {
  return tenantRank(role) >= tenantRank(perms.viewMinRole)
}
export function canCreateRecord(perms: ModulePermissions, role: TenantRole): boolean {
  return tenantRank(role) >= tenantRank(perms.createMinRole) && canViewModule(perms, role)
}
export function canEditRecord(perms: ModulePermissions, role: TenantRole): boolean {
  return tenantRank(role) >= tenantRank(perms.editMinRole) && canViewModule(perms, role)
}
export function canDeleteRecord(perms: ModulePermissions, role: TenantRole): boolean {
  return tenantRank(role) >= tenantRank(perms.deleteMinRole) && canViewModule(perms, role)
}

// ---------------------------------------------------------------------------
// Workflow — a lightweight per-module state machine
// ---------------------------------------------------------------------------

export type WorkflowState = {
  key: string
  label: string
  /** The state a record enters when it is first created. Exactly one. */
  isInitial: boolean
  /** A terminal state — no transitions leave it. */
  isFinal: boolean
}

export type WorkflowTransition = {
  from: string
  to: string
  label: string
  /** Minimum tenant role allowed to perform this transition. */
  minRole: TenantRole
}

export type ModuleWorkflow = {
  enabled: boolean
  states: WorkflowState[]
  transitions: WorkflowTransition[]
}

export const EMPTY_WORKFLOW: ModuleWorkflow = { enabled: false, states: [], transitions: [] }

function normalizeWorkflow(raw: any): { workflow: ModuleWorkflow; errors: string[] } {
  const errors: string[] = []
  const enabled = raw?.enabled === true
  if (!enabled) return { workflow: { ...EMPTY_WORKFLOW }, errors }

  const seen = new Set<string>()
  const states: WorkflowState[] = []
  for (const s of Array.isArray(raw?.states) ? raw.states : []) {
    const key = normalizeFieldKey(String(s?.key ?? s?.label ?? ""))
    const label = String(s?.label ?? key).trim()
    if (!key) continue
    if (seen.has(key)) {
      errors.push(`Duplicate workflow state "${key}".`)
      continue
    }
    seen.add(key)
    states.push({ key, label: label || key, isInitial: s?.isInitial === true, isFinal: s?.isFinal === true })
  }

  if (states.length < 2) errors.push("An enabled workflow needs at least two states.")

  const initial = states.filter((s) => s.isInitial)
  if (states.length >= 2) {
    if (initial.length === 0) states[0].isInitial = true
    else if (initial.length > 1) errors.push("A workflow can have only one initial state.")
  }

  const stateKeys = new Set(states.map((s) => s.key))
  const transitions: WorkflowTransition[] = []
  for (const t of Array.isArray(raw?.transitions) ? raw.transitions : []) {
    const from = normalizeFieldKey(String(t?.from ?? ""))
    const to = normalizeFieldKey(String(t?.to ?? ""))
    if (!from || !to) continue
    if (!stateKeys.has(from)) {
      errors.push(`Transition references unknown state "${from}".`)
      continue
    }
    if (!stateKeys.has(to)) {
      errors.push(`Transition references unknown state "${to}".`)
      continue
    }
    if (from === to) {
      errors.push("A transition cannot start and end on the same state.")
      continue
    }
    transitions.push({
      from,
      to,
      label: String(t?.label ?? `${from} → ${to}`).trim(),
      minRole: toTenantRole(t?.minRole ?? "employee"),
    })
  }

  if (states.length >= 2 && transitions.length === 0) {
    errors.push("An enabled workflow needs at least one transition.")
  }

  return { workflow: { enabled: true, states, transitions }, errors }
}

/** The state a new record starts in, or null when the workflow is disabled. */
export function initialState(workflow: ModuleWorkflow): string | null {
  if (!workflow.enabled) return null
  const explicit = workflow.states.find((s) => s.isInitial)
  return (explicit ?? workflow.states[0])?.key ?? null
}

export function isFinalState(workflow: ModuleWorkflow, stateKey: string | null): boolean {
  if (!stateKey) return false
  return workflow.states.some((s) => s.key === stateKey && s.isFinal)
}

/** The transitions legally available from `from` for a given role. */
export function availableTransitions(
  workflow: ModuleWorkflow,
  from: string | null,
  role: TenantRole,
): WorkflowTransition[] {
  if (!workflow.enabled || !from) return []
  return workflow.transitions.filter((t) => t.from === from && tenantRank(role) >= tenantRank(t.minRole))
}

export type TransitionResult = { ok: true; to: string } | { ok: false; error: string }

/**
 * Resolve a requested state transition. Re-derives legality and the actor's
 * authority from the workflow definition — the client can never force a state.
 */
export function applyTransition(
  workflow: ModuleWorkflow,
  from: string | null,
  to: string,
  role: TenantRole,
): TransitionResult {
  if (!workflow.enabled) return { ok: false, error: "This module has no workflow." }
  const target = normalizeFieldKey(String(to ?? ""))
  if (!target) return { ok: false, error: "A target state is required." }
  if (!workflow.states.some((s) => s.key === target)) {
    return { ok: false, error: `Unknown state "${to}".` }
  }
  const transition = workflow.transitions.find((t) => t.from === from && t.to === target)
  if (!transition) return { ok: false, error: `No transition from "${from ?? "—"}" to "${target}".` }
  if (tenantRank(role) < tenantRank(transition.minRole)) {
    return { ok: false, error: "You do not have permission to perform this transition." }
  }
  return { ok: true, to: target }
}

// ---------------------------------------------------------------------------
// List view + reports
// ---------------------------------------------------------------------------

export type ListView = {
  /** Field keys shown as columns, in order. Empty = show all list-flagged fields. */
  columns: string[]
}

export type ReportOp = "count" | "sum" | "avg" | "min" | "max"
export const REPORT_OPS: readonly ReportOp[] = ["count", "sum", "avg", "min", "max"] as const

export type ReportMetric = {
  key: string
  label: string
  op: ReportOp
  /** The numeric field the metric aggregates. Ignored (and optional) for count. */
  field: string | null
  /** Optional field key to group the metric by. */
  groupBy: string | null
}

export type ModuleReport = {
  key: string
  label: string
  metrics: ReportMetric[]
}

// ---------------------------------------------------------------------------
// Module definition
// ---------------------------------------------------------------------------

export type ModuleStatus = "draft" | "published" | "archived"

export type ModuleDefinition = {
  id: number | null
  slug: string
  name: string
  pluralName: string
  description: string
  icon: string
  navGroup: string
  status: ModuleStatus
  allowAttachments: boolean
  fields: ModuleField[]
  listView: ListView
  permissions: ModulePermissions
  workflow: ModuleWorkflow
  reports: ModuleReport[]
  version: number
}

export type ModuleDefInput = {
  id?: number | null
  slug?: string
  name: string
  pluralName?: string
  description?: string
  icon?: string
  navGroup?: string
  status?: string
  allowAttachments?: boolean
  fields?: ModuleFieldInput[]
  listView?: { columns?: unknown }
  permissions?: Partial<Record<keyof ModulePermissions, unknown>>
  workflow?: unknown
  reports?: any[]
}

const RESERVED_KEYS = new Set(["id", "state", "created_at", "updated_at", "created_by", "attachments"])

function validateReports(raw: any[] | undefined, fieldByKey: Map<string, ModuleField>): {
  reports: ModuleReport[]
  errors: string[]
} {
  const errors: string[] = []
  const reports: ModuleReport[] = []
  const numericKeys = new Set([...fieldByKey.values()].filter((f) => getFieldTypeDef(f.type)?.numeric).map((f) => f.key))
  const reportKeys = new Set<string>()
  for (const r of Array.isArray(raw) ? raw : []) {
    const key = normalizeFieldKey(String(r?.key ?? r?.label ?? ""))
    if (!key) continue
    if (reportKeys.has(key)) {
      errors.push(`Duplicate report "${key}".`)
      continue
    }
    reportKeys.add(key)
    const metrics: ReportMetric[] = []
    for (const m of Array.isArray(r?.metrics) ? r.metrics : []) {
      const op = String(m?.op ?? "") as ReportOp
      if (!REPORT_OPS.includes(op)) {
        errors.push(`Report "${key}" has an invalid metric operation "${m?.op}".`)
        continue
      }
      const field = m?.field ? normalizeFieldKey(String(m.field)) : null
      if (op !== "count") {
        if (!field) {
          errors.push(`Report "${key}" ${op} metric needs a numeric field.`)
          continue
        }
        if (!numericKeys.has(field)) {
          errors.push(`Report "${key}" ${op} metric references non-numeric field "${field}".`)
          continue
        }
      }
      const groupBy = m?.groupBy ? normalizeFieldKey(String(m.groupBy)) : null
      if (groupBy && !fieldByKey.has(groupBy)) {
        errors.push(`Report "${key}" groups by unknown field "${groupBy}".`)
        continue
      }
      metrics.push({
        key: normalizeFieldKey(String(m?.key ?? m?.label ?? op)) || op,
        label: String(m?.label ?? op).trim() || op,
        op,
        field: op === "count" ? null : field,
        groupBy,
      })
    }
    reports.push({ key, label: String(r?.label ?? key).trim() || key, metrics })
  }
  return { reports, errors }
}

/**
 * Validate + normalize a raw module definition into a safe ModuleDefinition, or
 * return the collected reasons. The API and console both funnel through here.
 */
export function validateModuleDefinition(
  input: ModuleDefInput,
): { ok: true; def: ModuleDefinition } | { ok: false; errors: string[] } {
  const errors: string[] = []

  const name = String(input.name ?? "").trim()
  if (!name) errors.push("A module name is required.")
  if (name.length > 80) errors.push("Module name must be 80 characters or fewer.")

  const slug = normalizeSlug(input.slug || slugFromName(name))
  if (!slug) errors.push("Could not derive a valid slug from the module name.")

  // Fields — validate each, enforce unique keys, and reject reserved keys.
  const numericKeys: string[] = []
  const rawFields = Array.isArray(input.fields) ? input.fields : []
  for (const f of rawFields) {
    const tentative = validateModuleField(f, [])
    if (tentative.ok && getFieldTypeDef(tentative.field.type)?.numeric) numericKeys.push(tentative.field.key)
  }

  const fields: ModuleField[] = []
  const keySeen = new Set<string>()
  for (const raw of rawFields) {
    const result = validateModuleField(raw, numericKeys)
    if (!result.ok) {
      errors.push(...result.errors)
      continue
    }
    const field = result.field
    if (RESERVED_KEYS.has(field.key)) {
      errors.push(`"${field.key}" is a reserved field key.`)
      continue
    }
    if (keySeen.has(field.key)) {
      errors.push(`Duplicate field key "${field.key}".`)
      continue
    }
    keySeen.add(field.key)
    fields.push(field)
  }

  if (fields.length === 0) errors.push("A module needs at least one field.")
  if (fields.length > 100) errors.push("A module may not have more than 100 fields.")

  const fieldByKey = new Map(fields.map((f) => [f.key, f]))

  // List view columns must reference real fields.
  const rawColumns = Array.isArray(input.listView?.columns) ? input.listView!.columns : []
  const columns: string[] = []
  for (const c of rawColumns) {
    const key = normalizeFieldKey(String(c))
    if (fieldByKey.has(key) && !columns.includes(key)) columns.push(key)
  }
  const listView: ListView =
    columns.length > 0
      ? { columns }
      : { columns: fields.filter((f) => f.showInList).map((f) => f.key) }

  const { perms, errors: permErrors } = normalizePermissions(input.permissions)
  errors.push(...permErrors)

  const { workflow, errors: wfErrors } = normalizeWorkflow(input.workflow)
  errors.push(...wfErrors)

  const { reports, errors: reportErrors } = validateReports(input.reports, fieldByKey)
  errors.push(...reportErrors)

  const status: ModuleStatus = ["draft", "published", "archived"].includes(String(input.status))
    ? (input.status as ModuleStatus)
    : "draft"

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    def: {
      id: input.id ?? null,
      slug,
      name,
      pluralName: String(input.pluralName ?? "").trim() || `${name}s`,
      description: String(input.description ?? "").trim(),
      icon: String(input.icon ?? "Blocks").trim() || "Blocks",
      navGroup: String(input.navGroup ?? "Custom").trim() || "Custom",
      status,
      allowAttachments: input.allowAttachments === true,
      fields,
      listView,
      permissions: perms,
      workflow,
      reports,
      version: 1,
    },
  }
}

// ---------------------------------------------------------------------------
// Record value validation (reuses the custom-field value engine + formulas)
// ---------------------------------------------------------------------------

export type Attachment = { name: string; url: string; size: number | null }

export function normalizeAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return []
  const out: Attachment[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const url = String((item as any).url ?? "").trim()
    if (!url) continue
    const name = String((item as any).name ?? url.split("/").pop() ?? "file").trim() || "file"
    const size = Number((item as any).size)
    out.push({ name, url, size: Number.isFinite(size) ? size : null })
    if (out.length >= 50) break
  }
  return out
}

/**
 * Validate + coerce a record's raw values against the module's fields. Unknown
 * keys are dropped, computed (formula) fields are derived from the validated
 * numeric values, and every editable field runs through the shared custom-field
 * value validator so a module record behaves exactly like a built-in one.
 */
export function validateRecordValues(
  def: ModuleDefinition,
  rawValues: Record<string, unknown>,
): { ok: true; values: Record<string, unknown> } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const values: Record<string, unknown> = {}
  const raw = rawValues && typeof rawValues === "object" ? rawValues : {}

  for (const field of def.fields) {
    const typeDef = getFieldTypeDef(field.type)
    if (typeDef?.computed) continue // formulas are derived below, never set
    const fieldDef = toFieldDefinition(def.slug, field)
    const result = validateFieldValue(fieldDef, raw[field.key])
    if (!result.ok) {
      errors[field.key] = result.error
      continue
    }
    if (result.value !== null && result.value !== undefined) values[field.key] = result.value
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  // Derive formula fields from the validated numeric operands.
  const numericValues: Record<string, number> = {}
  for (const field of def.fields) {
    const typeDef = getFieldTypeDef(field.type)
    if (typeDef?.numeric && !typeDef.computed) {
      numericValues[field.key] = numericValueOf(toFieldDefinition(def.slug, field), values[field.key])
    }
  }
  for (const field of def.fields) {
    const typeDef = getFieldTypeDef(field.type)
    if (typeDef?.computed && field.config.formula) {
      const computed = evaluateFormula(field.config.formula, numericValues)
      values[field.key] = computed == null ? null : computed
    }
  }

  return { ok: true, values }
}

/**
 * Project a stored record's values down to only the fields a role may view,
 * for list views and reads. Pure and defensive.
 */
export function projectVisibleValues(
  def: ModuleDefinition,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of def.fields) {
    if (field.key in values) out[field.key] = values[field.key]
  }
  return out
}
