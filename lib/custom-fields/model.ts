/**
 * SPEC 94 — Custom Fields: pure model (Phase 1 & 2).
 * ---------------------------------------------------------------------------
 * The metadata-driven, dependency-free core of the no-code custom-field engine.
 * It holds ZERO database access and no "server-only" marker so the SAME rules
 * drive the admin console, the browser form, the API and the server, and can be
 * unit-tested exhaustively without a live DB (see test/custom-fields.test.ts).
 *
 * A custom field is DATA, not code: a tenant describes a field (its type, the
 * options it offers, how it validates, who may see and edit it) and the engine
 * turns that description into validation, storage, dynamic-form rendering and
 * report projection. Nothing about a field is hard-coded per module — a module
 * only names the ENTITY its records belong to (contact, deal, invoice, …) and
 * the engine does the rest.
 *
 * Supported field types (the thirteen the spec enumerates):
 *   text · number · date · boolean · dropdown · multiselect · user ·
 *   department · entity · file · url · currency · formula (where safe)
 */
import { type TenantRole, tenantRank, toTenantRole } from "@/lib/role-model"

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------

export type FieldType =
  | "text"
  | "number"
  | "date"
  | "boolean"
  | "dropdown"
  | "multiselect"
  | "user"
  | "department"
  | "entity"
  | "file"
  | "url"
  | "currency"
  | "formula"

/** Broad grouping used to organise the type picker and drive shared behaviour. */
export type FieldCategory = "basic" | "choice" | "relation" | "computed"

export type FieldTypeDef = {
  type: FieldType
  label: string
  description: string
  category: FieldCategory
  /** dropdown / multiselect carry a fixed option list. */
  hasOptions: boolean
  /** user / department / entity point at another record by id. */
  isRelation: boolean
  /** formula is derived at read time and is never stored or directly set. */
  computed: boolean
  /** contributes a numeric operand to formulas. */
  numeric: boolean
}

export const FIELD_TYPES: readonly FieldTypeDef[] = [
  { type: "text", label: "Text", description: "A single line of free text.", category: "basic", hasOptions: false, isRelation: false, computed: false, numeric: false },
  { type: "number", label: "Number", description: "A numeric value with optional range and precision.", category: "basic", hasOptions: false, isRelation: false, computed: false, numeric: true },
  { type: "date", label: "Date", description: "A calendar date (ISO yyyy-mm-dd).", category: "basic", hasOptions: false, isRelation: false, computed: false, numeric: false },
  { type: "boolean", label: "Boolean", description: "A yes / no toggle.", category: "basic", hasOptions: false, isRelation: false, computed: false, numeric: false },
  { type: "dropdown", label: "Dropdown", description: "Pick one value from a fixed list.", category: "choice", hasOptions: true, isRelation: false, computed: false, numeric: false },
  { type: "multiselect", label: "Multi-select", description: "Pick any number of values from a fixed list.", category: "choice", hasOptions: true, isRelation: false, computed: false, numeric: false },
  { type: "user", label: "User", description: "Reference a user in this tenant.", category: "relation", hasOptions: false, isRelation: true, computed: false, numeric: false },
  { type: "department", label: "Department", description: "Reference a department.", category: "relation", hasOptions: false, isRelation: true, computed: false, numeric: false },
  { type: "entity", label: "Entity", description: "Reference another record (contact, deal, …).", category: "relation", hasOptions: false, isRelation: true, computed: false, numeric: false },
  { type: "file", label: "File", description: "An uploaded file (name + url).", category: "basic", hasOptions: false, isRelation: false, computed: false, numeric: false },
  { type: "url", label: "URL", description: "A validated web link.", category: "basic", hasOptions: false, isRelation: false, computed: false, numeric: false },
  { type: "currency", label: "Currency", description: "A monetary amount with a currency code.", category: "basic", hasOptions: false, isRelation: false, computed: false, numeric: true },
  { type: "formula", label: "Formula", description: "A safe arithmetic expression over other numeric fields.", category: "computed", hasOptions: false, isRelation: false, computed: true, numeric: true },
] as const

const TYPE_MAP = new Map<string, FieldTypeDef>(FIELD_TYPES.map((t) => [t.type, t]))

export function isFieldType(value: string): value is FieldType {
  return TYPE_MAP.has(value)
}

export function getFieldTypeDef(type: string): FieldTypeDef | undefined {
  return TYPE_MAP.get(type)
}

// ---------------------------------------------------------------------------
// Entity catalogue — which record types can carry custom fields
// ---------------------------------------------------------------------------

export type EntityDef = { entityType: string; label: string; module: string }

/**
 * The records that participate in the custom-field engine. A module opts a
 * record type in simply by appearing here; the engine needs nothing else.
 */
export const ENTITY_TYPES: readonly EntityDef[] = [
  { entityType: "contact", label: "Contact", module: "CRM" },
  { entityType: "account", label: "Account / Company", module: "CRM" },
  { entityType: "lead", label: "Lead", module: "CRM" },
  { entityType: "deal", label: "Deal", module: "CRM" },
  { entityType: "project", label: "Project", module: "Delivery" },
  { entityType: "task", label: "Task", module: "Delivery" },
  { entityType: "invoice", label: "Invoice", module: "Finance" },
  { entityType: "product", label: "Product", module: "Inventory" },
  { entityType: "employee", label: "Employee", module: "HR" },
  { entityType: "asset", label: "Asset", module: "Operations" },
] as const

const ENTITY_MAP = new Map<string, EntityDef>(ENTITY_TYPES.map((e) => [e.entityType, e]))

export function normalizeEntityType(entityType: string): string {
  return String(entityType ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "")
}

export function getEntityDef(entityType: string): EntityDef | undefined {
  return ENTITY_MAP.get(normalizeEntityType(entityType))
}

export function isKnownEntityType(entityType: string): boolean {
  return ENTITY_MAP.has(normalizeEntityType(entityType))
}

// ---------------------------------------------------------------------------
// Field option + config + definition shapes
// ---------------------------------------------------------------------------

export type FieldOption = { value: string; label: string }

export type FieldConfig = {
  /** text: max characters. number/currency: value bounds. */
  min?: number | null
  max?: number | null
  /** number/currency: decimal places (0–6). */
  precision?: number | null
  /** currency: default ISO currency code, e.g. USD. */
  currencyCode?: string | null
  /** entity relation: which entity type this points at. */
  targetEntity?: string | null
  /** formula: the arithmetic expression (references other numeric field keys). */
  formula?: string | null
}

export type FieldDefinition = {
  entityType: string
  key: string
  label: string
  type: FieldType
  required: boolean
  options: FieldOption[]
  config: FieldConfig
  defaultValue: unknown
  helpText: string
  /** Minimum tenant role that may SEE this field. */
  viewMinRole: TenantRole
  /** Minimum tenant role that may EDIT this field. */
  editMinRole: TenantRole
  active: boolean
  sortOrder: number
}

// ---------------------------------------------------------------------------
// Key + option normalization
// ---------------------------------------------------------------------------

/** A field key: lowercase, alnum + underscore, never leading digit. */
export function normalizeFieldKey(key: string): string {
  let k = String(key ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")
  if (k && /^[0-9]/.test(k)) k = `f_${k}`
  return k
}

/** Derive a key from a human label when the author didn't supply one. */
export function keyFromLabel(label: string): string {
  return normalizeFieldKey(label)
}

function normalizeOptions(raw: unknown): FieldOption[] {
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

// ---------------------------------------------------------------------------
// Safe formula engine (the "where safe" of the spec)
// ---------------------------------------------------------------------------
//
// Formulas are NEVER evaluated with the JS engine. We accept only a tiny
// grammar — numeric literals, references to other numeric fields, the four
// arithmetic operators plus modulo, parentheses and unary minus — and evaluate
// it with a hand-written parser. This makes injection impossible: there is no
// property access, no function calls, no globals, nothing but arithmetic.

const FORMULA_ALLOWED = /^[a-z0-9_+\-*/%().\s]+$/i
const IDENTIFIER = /[a-z_][a-z0-9_]*/gi

/** The set of field keys a formula references (for dependency + safety checks). */
export function extractFormulaRefs(formula: string): string[] {
  const src = String(formula ?? "")
  const found = new Set<string>()
  for (const m of src.matchAll(IDENTIFIER)) found.add(m[0].toLowerCase())
  return [...found]
}

export type FormulaCheck = { ok: true; refs: string[] } | { ok: false; error: string }

/**
 * Static validation of a formula: character whitelist, balanced parentheses and
 * a parse dry-run with all references set to 1. Does not need the real values.
 */
export function checkFormula(formula: string, knownRefs: readonly string[]): FormulaCheck {
  const src = String(formula ?? "").trim()
  if (!src) return { ok: false, error: "A formula expression is required." }
  if (!FORMULA_ALLOWED.test(src)) {
    return { ok: false, error: "Formula may only use numbers, field keys, + - * / % and parentheses." }
  }
  let depth = 0
  for (const ch of src) {
    if (ch === "(") depth++
    else if (ch === ")") {
      depth--
      if (depth < 0) return { ok: false, error: "Unbalanced parentheses in formula." }
    }
  }
  if (depth !== 0) return { ok: false, error: "Unbalanced parentheses in formula." }

  const refs = extractFormulaRefs(src)
  const known = new Set(knownRefs.map((r) => r.toLowerCase()))
  for (const r of refs) {
    if (!known.has(r)) return { ok: false, error: `Formula references unknown numeric field "${r}".` }
  }
  // Parse dry-run with every reference = 1 to catch malformed expressions.
  const probe: Record<string, number> = {}
  for (const r of refs) probe[r] = 1
  const result = evaluateFormula(src, probe)
  if (result === undefined) return { ok: false, error: "Formula could not be parsed." }
  return { ok: true, refs }
}

/**
 * Evaluate a validated formula against numeric values. Returns:
 *   number     — the computed result,
 *   null       — a runtime issue that isn't an error (e.g. division by zero),
 *   undefined  — the expression is malformed (used by the static check).
 * Unknown / non-numeric references resolve to 0.
 */
export function evaluateFormula(formula: string, values: Record<string, number>): number | null | undefined {
  const src = String(formula ?? "")
  if (!FORMULA_ALLOWED.test(src)) return undefined

  let pos = 0
  let divByZero = false

  function skipWs() {
    while (pos < src.length && /\s/.test(src[pos])) pos++
  }

  // expr := term (('+' | '-') term)*
  function parseExpr(): number | undefined {
    let left = parseTerm()
    if (left === undefined) return undefined
    for (;;) {
      skipWs()
      const op = src[pos]
      if (op === "+" || op === "-") {
        pos++
        const right = parseTerm()
        if (right === undefined) return undefined
        left = op === "+" ? left + right : left - right
      } else break
    }
    return left
  }

  // term := factor (('*' | '/' | '%') factor)*
  function parseTerm(): number | undefined {
    let left = parseFactor()
    if (left === undefined) return undefined
    for (;;) {
      skipWs()
      const op = src[pos]
      if (op === "*" || op === "/" || op === "%") {
        pos++
        const right = parseFactor()
        if (right === undefined) return undefined
        if (op === "*") left = left * right
        else {
          if (right === 0) {
            divByZero = true
            left = 0
          } else left = op === "/" ? left / right : left % right
        }
      } else break
    }
    return left
  }

  // factor := '-' factor | '(' expr ')' | number | identifier
  function parseFactor(): number | undefined {
    skipWs()
    if (pos >= src.length) return undefined
    const ch = src[pos]
    if (ch === "-") {
      pos++
      const f = parseFactor()
      return f === undefined ? undefined : -f
    }
    if (ch === "+") {
      pos++
      return parseFactor()
    }
    if (ch === "(") {
      pos++
      const inner = parseExpr()
      if (inner === undefined) return undefined
      skipWs()
      if (src[pos] !== ")") return undefined
      pos++
      return inner
    }
    const numMatch = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(pos))
    if (numMatch) {
      pos += numMatch[0].length
      return Number(numMatch[0])
    }
    const idMatch = /^[a-z_][a-z0-9_]*/i.exec(src.slice(pos))
    if (idMatch) {
      pos += idMatch[0].length
      const key = idMatch[0].toLowerCase()
      const v = values[key]
      return typeof v === "number" && Number.isFinite(v) ? v : 0
    }
    return undefined
  }

  const result = parseExpr()
  skipWs()
  if (result === undefined || pos !== src.length) return undefined
  if (divByZero) return null
  return Number.isFinite(result) ? result : null
}

// ---------------------------------------------------------------------------
// Field-definition validation
// ---------------------------------------------------------------------------

export type FieldDefInput = {
  entityType: string
  key?: string
  label: string
  type: string
  required?: boolean
  options?: unknown
  config?: Partial<FieldConfig>
  defaultValue?: unknown
  helpText?: string
  viewMinRole?: string
  editMinRole?: string
  active?: boolean
  sortOrder?: number
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

/**
 * Validate + normalize a raw field definition into a safe FieldDefinition, or
 * return the collected reasons. The API and console both funnel through here.
 * `siblingNumericKeys` are the entity's OTHER numeric field keys, needed to
 * validate a formula's references.
 */
export function validateFieldDef(
  input: FieldDefInput,
  siblingNumericKeys: readonly string[] = [],
): { ok: true; def: FieldDefinition } | { ok: false; errors: string[] } {
  const errors: string[] = []

  const entityType = normalizeEntityType(input.entityType)
  if (!entityType) errors.push("An entity type is required.")
  else if (!isKnownEntityType(entityType)) errors.push(`Unknown entity type "${input.entityType}".`)

  const label = String(input.label ?? "").trim()
  if (!label) errors.push("A field label is required.")

  const type = String(input.type ?? "")
  const typeDef = getFieldTypeDef(type)
  if (!typeDef) errors.push(`Field type must be one of: ${FIELD_TYPES.map((t) => t.type).join(", ")}.`)

  const key = normalizeFieldKey(input.key || keyFromLabel(label))
  if (!key) errors.push("Could not derive a valid field key from the label.")
  if (key.length > 60) errors.push("Field key must be 60 characters or fewer.")

  const viewMinRole = toTenantRole(input.viewMinRole ?? "employee")
  const editMinRole = toTenantRole(input.editMinRole ?? "employee")
  // You cannot grant edit access below view access — nobody should be able to
  // change a field they aren't cleared to see (fail-safe permission ordering).
  if (tenantRank(editMinRole) < tenantRank(viewMinRole)) {
    errors.push("Edit access cannot be broader than view access.")
  }

  const options = normalizeOptions(input.options)
  const config: FieldConfig = {}

  if (typeDef) {
    if (typeDef.hasOptions) {
      if (options.length === 0) errors.push(`${typeDef.label} fields need at least one option.`)
      if (options.length > 200) errors.push("A field may not have more than 200 options.")
    }

    if (typeDef.type === "entity") {
      const target = normalizeEntityType(String(input.config?.targetEntity ?? ""))
      if (!target) errors.push("An entity field must name the entity it points to.")
      else if (!isKnownEntityType(target)) errors.push(`Unknown target entity "${input.config?.targetEntity}".`)
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

  // A computed field is inherently read-only and cannot be "required".
  const required = typeDef?.computed ? false : input.required === true

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    def: {
      entityType,
      key,
      label,
      type: type as FieldType,
      required,
      options: typeDef!.hasOptions ? options : [],
      config,
      defaultValue: input.defaultValue ?? null,
      helpText: String(input.helpText ?? "").trim(),
      viewMinRole,
      editMinRole,
      active: input.active !== false,
      sortOrder: Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Value validation
// ---------------------------------------------------------------------------

export type ValueOk = { ok: true; value: unknown }
export type ValueErr = { ok: false; error: string }
export type ValueResult = ValueOk | ValueErr

function blank(value: unknown): boolean {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0)
}

/**
 * Validate + coerce a single raw value against its field definition. Pure: it
 * enforces presence, type and shape but performs no I/O (relation ids are shape-
 * checked, existence is the caller's job). Formula fields reject any direct set.
 */
export function validateFieldValue(def: FieldDefinition, rawValue: unknown): ValueResult {
  const typeDef = getFieldTypeDef(def.type)
  if (!typeDef) return { ok: false, error: "Unknown field type." }

  if (typeDef.computed) {
    return { ok: false, error: "Formula fields are computed and cannot be set directly." }
  }

  if (blank(rawValue)) {
    if (def.required) return { ok: false, error: `${def.label} is required.` }
    return { ok: true, value: null }
  }

  switch (def.type) {
    case "text": {
      const s = String(rawValue)
      const max = def.config.max ?? 10000
      if (s.length > max) return { ok: false, error: `${def.label} must be ${max} characters or fewer.` }
      return { ok: true, value: s }
    }
    case "url": {
      const s = String(rawValue).trim()
      try {
        const u = new URL(s)
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          return { ok: false, error: `${def.label} must be an http(s) URL.` }
        }
        return { ok: true, value: u.toString() }
      } catch {
        return { ok: false, error: `${def.label} must be a valid URL.` }
      }
    }
    case "number":
    case "currency": {
      const amount = def.type === "currency" && rawValue && typeof rawValue === "object"
        ? Number((rawValue as any).amount)
        : Number(rawValue)
      if (!Number.isFinite(amount)) return { ok: false, error: `${def.label} must be a number.` }
      if (def.config.min != null && amount < def.config.min) {
        return { ok: false, error: `${def.label} must be at least ${def.config.min}.` }
      }
      if (def.config.max != null && amount > def.config.max) {
        return { ok: false, error: `${def.label} must be at most ${def.config.max}.` }
      }
      const precision = def.config.precision ?? (def.type === "currency" ? 2 : 6)
      const rounded = Number(amount.toFixed(precision))
      if (def.type === "currency") {
        const code = def.config.currencyCode ?? "USD"
        return { ok: true, value: { amount: rounded, currency: code } }
      }
      return { ok: true, value: rounded }
    }
    case "date": {
      const s = String(rawValue).trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return { ok: false, error: `${def.label} must be a date (yyyy-mm-dd).` }
      }
      const d = new Date(`${s}T00:00:00Z`)
      if (Number.isNaN(d.getTime())) return { ok: false, error: `${def.label} is not a valid date.` }
      return { ok: true, value: s }
    }
    case "boolean": {
      if (typeof rawValue === "boolean") return { ok: true, value: rawValue }
      const s = String(rawValue).toLowerCase()
      if (["true", "1", "yes", "on"].includes(s)) return { ok: true, value: true }
      if (["false", "0", "no", "off"].includes(s)) return { ok: true, value: false }
      return { ok: false, error: `${def.label} must be true or false.` }
    }
    case "dropdown": {
      const s = String(rawValue)
      if (!def.options.some((o) => o.value === s)) {
        return { ok: false, error: `${s} is not a valid option for ${def.label}.` }
      }
      return { ok: true, value: s }
    }
    case "multiselect": {
      const arr = Array.isArray(rawValue) ? rawValue.map(String) : [String(rawValue)]
      const valid = new Set(def.options.map((o) => o.value))
      const unique: string[] = []
      for (const v of arr) {
        if (!valid.has(v)) return { ok: false, error: `${v} is not a valid option for ${def.label}.` }
        if (!unique.includes(v)) unique.push(v)
      }
      return { ok: true, value: unique }
    }
    case "user":
    case "department": {
      const id = Number(rawValue)
      if (!Number.isInteger(id) || id <= 0) {
        return { ok: false, error: `${def.label} must reference a valid ${def.type}.` }
      }
      return { ok: true, value: id }
    }
    case "entity": {
      const id = String(rawValue).trim()
      if (!id) return { ok: false, error: `${def.label} must reference a record.` }
      return { ok: true, value: { entity: def.config.targetEntity ?? null, id } }
    }
    case "file": {
      if (typeof rawValue === "string") {
        const s = rawValue.trim()
        if (!s) return { ok: false, error: `${def.label} is required.` }
        return { ok: true, value: { name: s.split("/").pop() || s, url: s } }
      }
      if (rawValue && typeof rawValue === "object") {
        const url = String((rawValue as any).url ?? "").trim()
        if (!url) return { ok: false, error: `${def.label} needs a file url.` }
        const name = String((rawValue as any).name ?? url.split("/").pop() ?? "file")
        const size = Number((rawValue as any).size)
        return { ok: true, value: { name, url, size: Number.isFinite(size) ? size : null } }
      }
      return { ok: false, error: `${def.label} must be a file.` }
    }
    default:
      return { ok: false, error: "Unsupported field type." }
  }
}

/** The numeric operand a field contributes to a formula (0 when not numeric). */
export function numericValueOf(def: FieldDefinition, value: unknown): number {
  if (value == null) return 0
  if (def.type === "number") {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  if (def.type === "currency") {
    const n = Number(typeof value === "object" ? (value as any).amount : value)
    return Number.isFinite(n) ? n : 0
  }
  if (def.type === "boolean") return value ? 1 : 0
  return 0
}

// ---------------------------------------------------------------------------
// Permissions (Phase 4)
// ---------------------------------------------------------------------------

export function canViewField(def: Pick<FieldDefinition, "viewMinRole">, role: TenantRole): boolean {
  return tenantRank(role) >= tenantRank(def.viewMinRole)
}

export function canEditField(
  def: Pick<FieldDefinition, "type" | "viewMinRole" | "editMinRole">,
  role: TenantRole,
): boolean {
  const typeDef = getFieldTypeDef(def.type)
  if (typeDef?.computed) return false // formulas are always read-only
  return tenantRank(role) >= tenantRank(def.editMinRole) && canViewField(def, role)
}
