/**
 * SPEC 102 — Data Validation Engine: pure model (Phase 1 & 2).
 * ---------------------------------------------------------------------------
 * A single, reusable validation framework so that APIs, forms and bulk imports
 * stop hand-rolling the same "is this required / a valid email / in range"
 * logic in dozens of places (the duplication Phase 1 audits). It is entirely
 * DATA-DRIVEN: a caller describes an entity's fields and rules once, and the
 * engine turns that description into consistent validation everywhere.
 *
 * This file holds ZERO database access and no "server-only" marker on purpose —
 * the SAME rules run in the browser (instant form feedback), in the API handler
 * (authoritative rejection) and in an import worker, and can be exhaustively
 * unit-tested without a live DB (see test/validation-engine.test.ts).
 *
 * The seven validation kinds the spec enumerates:
 *   Required          — presence.
 *   Format            — named formats (email, phone, gstin, ifsc, pan, url, …).
 *   Range             — numeric / date bounds (also length for strings).
 *   Uniqueness        — declared here, RESOLVED by the service (needs the DB);
 *                       the pure engine consumes precomputed lookup results.
 *   Cross-field       — one field compared against another (start < end, …).
 *   Conditional       — a rule/field only applies when a condition holds.
 *   Business-rule     — a named custom predicate supplied by the caller.
 */

// ---------------------------------------------------------------------------
// Core value helpers
// ---------------------------------------------------------------------------

export type RecordData = Record<string, unknown>

/** A value counts as "blank" (absent) for presence + skip-when-empty rules. */
export function isBlank(value: unknown): boolean {
  if (value == null) return true
  if (typeof value === "string") return value.trim() === ""
  if (Array.isArray(value)) return value.length === 0
  return false
}

function asString(value: unknown): string {
  if (value == null) return ""
  return typeof value === "string" ? value : String(value)
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null
  if (typeof value === "boolean") return value ? 1 : 0
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, "").trim())
  return Number.isFinite(n) ? n : null
}

/** Parse a value to a comparable epoch for date comparisons, or null. */
function asDate(value: unknown): number | null {
  if (value == null || value === "") return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime()
  const t = Date.parse(String(value))
  return Number.isNaN(t) ? null : t
}

// ---------------------------------------------------------------------------
// Named formats
// ---------------------------------------------------------------------------

export type FormatName =
  | "email"
  | "phone"
  | "url"
  | "pan"
  | "gstin"
  | "ifsc"
  | "pincode"
  | "ipv4"
  | "uuid"
  | "slug"
  | "alpha"
  | "alphanumeric"
  | "numeric"
  | "integer"
  | "decimal"
  | "date"
  | "datetime"
  | "time"
  | "hexColor"

type FormatDef = { test: (v: string) => boolean; message: string }

// Format-only regexes. These deliberately DUPLICATE (not import) the shapes in
// the server-only gstin.ts / ifsc.ts so this file stays browser-safe. They
// check SHAPE only; authoritative lookups (does this GSTIN exist?) live server-side.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URL_RE = /^https?:\/\/[^\s.]+\.[^\s]+$/i
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/
const PINCODE_RE = /^[1-9][0-9]{5}$/
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ALPHA_RE = /^[A-Za-z]+$/
const ALNUM_RE = /^[A-Za-z0-9]+$/
const INT_RE = /^-?\d+$/
const DECIMAL_RE = /^-?\d+(\.\d+)?$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/** Digits-only length between 7 and 15 (E.164 without the +). */
function isPhone(v: string): boolean {
  const digits = v.replace(/[\s\-().+]/g, "")
  return /^\d{7,15}$/.test(digits)
}

function isRealDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false
  const [y, m, d] = v.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export const FORMATS: Record<FormatName, FormatDef> = {
  email: { test: (v) => EMAIL_RE.test(v), message: "Enter a valid email address." },
  phone: { test: isPhone, message: "Enter a valid phone number." },
  url: { test: (v) => URL_RE.test(v), message: "Enter a valid URL (starting with http:// or https://)." },
  pan: { test: (v) => PAN_RE.test(v.toUpperCase()), message: "Enter a valid 10-character PAN (e.g. ABCDE1234F)." },
  gstin: { test: (v) => GSTIN_RE.test(v.toUpperCase()), message: "Enter a valid 15-character GSTIN." },
  ifsc: { test: (v) => IFSC_RE.test(v.toUpperCase()), message: "Enter a valid 11-character IFSC." },
  pincode: { test: (v) => PINCODE_RE.test(v), message: "Enter a valid 6-digit PIN code." },
  ipv4: { test: (v) => IPV4_RE.test(v), message: "Enter a valid IPv4 address." },
  uuid: { test: (v) => UUID_RE.test(v), message: "Enter a valid UUID." },
  slug: { test: (v) => SLUG_RE.test(v), message: "Use lowercase letters, numbers and hyphens only." },
  alpha: { test: (v) => ALPHA_RE.test(v), message: "Use letters only." },
  alphanumeric: { test: (v) => ALNUM_RE.test(v), message: "Use letters and numbers only." },
  numeric: { test: (v) => DECIMAL_RE.test(v), message: "Enter a number." },
  integer: { test: (v) => INT_RE.test(v), message: "Enter a whole number." },
  decimal: { test: (v) => DECIMAL_RE.test(v), message: "Enter a decimal number." },
  date: { test: isRealDate, message: "Enter a valid date (YYYY-MM-DD)." },
  datetime: { test: (v) => DATETIME_RE.test(v) && !Number.isNaN(Date.parse(v)), message: "Enter a valid date and time." },
  time: { test: (v) => TIME_RE.test(v), message: "Enter a valid time (HH:MM)." },
  hexColor: { test: (v) => HEX_COLOR_RE.test(v), message: "Enter a valid hex color (e.g. #1a2b3c)." },
}

export function checkFormat(format: FormatName, value: unknown): boolean {
  const def = FORMATS[format]
  if (!def) return true
  return def.test(asString(value).trim())
}

// ---------------------------------------------------------------------------
// Conditions (drive Conditional validation)
// ---------------------------------------------------------------------------

export type Comparator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "nin"
  | "empty"
  | "notEmpty"
  | "truthy"
  | "falsy"
  | "before"
  | "after"

export type Condition =
  | { field: string; op: Comparator; value?: unknown; as?: "number" | "date" | "string" }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }

function compareOp(op: Comparator, left: unknown, right: unknown, as?: "number" | "date" | "string"): boolean {
  switch (op) {
    case "empty":
      return isBlank(left)
    case "notEmpty":
      return !isBlank(left)
    case "truthy":
      return Boolean(left) && left !== "false" && left !== "0"
    case "falsy":
      return !left || left === "false" || left === "0"
    case "in":
      return Array.isArray(right) && right.some((r) => looseEqual(left, r))
    case "nin":
      return Array.isArray(right) && !right.some((r) => looseEqual(left, r))
    case "eq":
      return looseEqual(left, right)
    case "neq":
      return !looseEqual(left, right)
  }
  // Ordered comparisons: coerce to number, date or string.
  if (as === "date" || op === "before" || op === "after") {
    const l = asDate(left)
    const r = asDate(right)
    if (l == null || r == null) return false
    if (op === "before" || op === "lt") return l < r
    if (op === "after" || op === "gt") return l > r
    if (op === "lte") return l <= r
    if (op === "gte") return l >= r
    return false
  }
  if (as === "string") {
    const l = asString(left)
    const r = asString(right)
    if (op === "gt") return l > r
    if (op === "gte") return l >= r
    if (op === "lt") return l < r
    if (op === "lte") return l <= r
    return false
  }
  const l = asNumber(left)
  const r = asNumber(right)
  if (l == null || r == null) return false
  if (op === "gt") return l > r
  if (op === "gte") return l >= r
  if (op === "lt") return l < r
  if (op === "lte") return l <= r
  return false
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  return asString(a).trim().toLowerCase() === asString(b).trim().toLowerCase()
}

/** Evaluate a condition tree against a record. Absent fields read as undefined. */
export function evaluateCondition(cond: Condition | undefined, record: RecordData): boolean {
  if (!cond) return true
  if ("all" in cond) return cond.all.every((c) => evaluateCondition(c, record))
  if ("any" in cond) return cond.any.some((c) => evaluateCondition(c, record))
  if ("not" in cond) return !evaluateCondition(cond.not, record)
  return compareOp(cond.op, record[cond.field], cond.value, cond.as)
}

// ---------------------------------------------------------------------------
// Rule shapes
// ---------------------------------------------------------------------------

export type FieldRule =
  | { type: "required"; message?: string; when?: Condition }
  | { type: "format"; format: FormatName; message?: string; when?: Condition }
  | { type: "pattern"; pattern: string; flags?: string; message?: string; when?: Condition }
  | { type: "length"; min?: number; max?: number; message?: string; when?: Condition }
  | {
      type: "range"
      min?: number
      max?: number
      exclusiveMin?: boolean
      exclusiveMax?: boolean
      as?: "number" | "date"
      message?: string
      when?: Condition
    }
  | { type: "enum"; values: Array<string | number>; caseInsensitive?: boolean; message?: string; when?: Condition }
  | { type: "unique"; scope?: string; message?: string; when?: Condition }

export type FieldValidation = {
  key: string
  label?: string
  /** Field rules only run when this holds (Conditional validation, field level). */
  when?: Condition
  /** Trim string values before checking (default true). */
  trim?: boolean
  rules: FieldRule[]
}

export type CrossFieldRule = {
  type: "cross-field"
  /** The field the error attaches to. */
  field: string
  op: Comparator
  /** Compare against another field by key… */
  other?: string
  /** …or against a constant. */
  value?: unknown
  as?: "number" | "date" | "string"
  message?: string
  when?: Condition
}

export type BusinessRuleRef = {
  type: "business-rule"
  /** Key into the business-rule registry passed to validateRecord. */
  name: string
  /** Field(s) the resulting error attaches to (defaults to record-level "_form"). */
  fields?: string[]
  message?: string
  when?: Condition
}

export type ValidationSchema = {
  entity: string
  fields: FieldValidation[]
  crossField?: CrossFieldRule[]
  businessRules?: BusinessRuleRef[]
}

// ---------------------------------------------------------------------------
// Business-rule contract
// ---------------------------------------------------------------------------

export type ValidationContext = {
  tenantId?: number
  recordId?: string | number | null
  /** true when validating a create (vs. update) — business rules may branch. */
  isCreate?: boolean
  [key: string]: unknown
}

export type BusinessRuleOutcome =
  | true
  | { ok: true }
  | { ok: false; message?: string; fieldErrors?: Record<string, string> }

export type BusinessRuleFn = (record: RecordData, ctx: ValidationContext) => BusinessRuleOutcome

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type ValidationIssue = { field: string; rule: string; message: string }

export type ValidationResult = {
  ok: boolean
  issues: ValidationIssue[]
  /** field -> all messages */
  fieldErrors: Record<string, string[]>
  /** field -> first message (ready for the API's validationError details shape) */
  firstErrors: Record<string, string>
}

/** The record-level bucket cross-field / business rules attach to by default. */
export const FORM_FIELD = "_form"

// ---------------------------------------------------------------------------
// Uniqueness declaration collection (consumed by the service layer)
// ---------------------------------------------------------------------------

export type UniqueCheck = { field: string; scope: string; value: unknown }

/**
 * Collect the uniqueness checks a record actually needs, honoring conditional
 * rules and skipping blank values. The service resolves each against the DB and
 * feeds the results back into validateRecord via `duplicates`.
 */
export function collectUniqueChecks(schema: ValidationSchema, record: RecordData): UniqueCheck[] {
  const out: UniqueCheck[] = []
  for (const field of schema.fields) {
    if (!evaluateCondition(field.when, record)) continue
    const raw = record[field.key]
    const value = field.trim === false ? raw : typeof raw === "string" ? raw.trim() : raw
    if (isBlank(value)) continue
    for (const rule of field.rules) {
      if (rule.type !== "unique") continue
      if (!evaluateCondition(rule.when, record)) continue
      out.push({ field: field.key, scope: rule.scope ?? field.key, value })
    }
  }
  return out
}

/** Build the key the engine uses to look up a resolved uniqueness result. */
export function uniqueKey(field: string, scope: string): string {
  return `${scope}::${field}`
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export type ValidateOptions = {
  ctx?: ValidationContext
  /** Named business-rule implementations referenced by schema.businessRules. */
  businessRules?: Record<string, BusinessRuleFn>
  /**
   * Resolved uniqueness results keyed by uniqueKey(field, scope):
   * true  => the value is already taken (=> a uniqueness error is raised),
   * false/absent => unique / not checked.
   */
  duplicates?: Record<string, boolean>
}

function fieldLabel(field: FieldValidation): string {
  return field.label ?? field.key
}

function applyFieldRule(
  field: FieldValidation,
  rule: FieldRule,
  value: unknown,
  record: RecordData,
  opts: ValidateOptions,
): string | null {
  const label = fieldLabel(field)
  const present = !isBlank(value)

  // Required is the only rule that fires ON a blank value; every other rule
  // skips blanks so optional fields don't error when left empty.
  if (rule.type === "required") {
    return present ? null : rule.message ?? `${label} is required.`
  }
  if (!present) return null

  switch (rule.type) {
    case "format":
      return checkFormat(rule.format, value) ? null : rule.message ?? FORMATS[rule.format].message
    case "pattern": {
      let re: RegExp
      try {
        re = new RegExp(rule.pattern, rule.flags)
      } catch {
        return null // a malformed pattern never blocks the user; it's a config bug
      }
      return re.test(asString(value)) ? null : rule.message ?? `${label} is not in the expected format.`
    }
    case "length": {
      const len = Array.isArray(value) ? value.length : asString(value).length
      if (rule.min != null && len < rule.min) {
        return rule.message ?? `${label} must be at least ${rule.min} characters.`
      }
      if (rule.max != null && len > rule.max) {
        return rule.message ?? `${label} must be at most ${rule.max} characters.`
      }
      return null
    }
    case "range": {
      const num = rule.as === "date" ? asDate(value) : asNumber(value)
      if (num == null) return rule.message ?? `${label} must be a valid ${rule.as === "date" ? "date" : "number"}.`
      const lo = rule.as === "date" ? asDate(rule.min) : (rule.min ?? null)
      const hi = rule.as === "date" ? asDate(rule.max) : (rule.max ?? null)
      if (lo != null && (rule.exclusiveMin ? num <= lo : num < lo)) {
        return rule.message ?? `${label} is below the allowed minimum.`
      }
      if (hi != null && (rule.exclusiveMax ? num >= hi : num > hi)) {
        return rule.message ?? `${label} is above the allowed maximum.`
      }
      return null
    }
    case "enum": {
      const v = rule.caseInsensitive ? asString(value).toLowerCase() : value
      const set = rule.values.map((x) => (rule.caseInsensitive ? asString(x).toLowerCase() : x))
      const hit = set.some((x) => looseEqual(x, v))
      return hit ? null : rule.message ?? `${label} must be one of: ${rule.values.join(", ")}.`
    }
    case "unique": {
      const key = uniqueKey(field.key, rule.scope ?? field.key)
      const taken = opts.duplicates?.[key] === true
      return taken ? rule.message ?? `${label} is already in use.` : null
    }
  }
  return null
}

/**
 * Validate a record against a schema. Pure and synchronous: uniqueness has
 * already been resolved into `opts.duplicates`, and business rules are pure
 * functions the caller supplies. Returns a stable, structured result.
 */
export function validateRecord(
  schema: ValidationSchema,
  record: RecordData,
  opts: ValidateOptions = {},
): ValidationResult {
  const issues: ValidationIssue[] = []
  const add = (field: string, rule: string, message: string) => issues.push({ field, rule, message })

  // 1) Field-level rules (Required / Format / Range / length / enum / Uniqueness),
  //    each optionally Conditional.
  for (const field of schema.fields) {
    if (!evaluateCondition(field.when, record)) continue
    const raw = record[field.key]
    const value = field.trim === false ? raw : typeof raw === "string" ? raw.trim() : raw
    for (const rule of field.rules) {
      if (!evaluateCondition(rule.when, record)) continue
      const msg = applyFieldRule(field, rule, value, record, opts)
      if (msg) add(field.key, rule.type, msg)
    }
  }

  // 2) Cross-field rules.
  for (const rule of schema.crossField ?? []) {
    if (!evaluateCondition(rule.when, record)) continue
    const left = record[rule.field]
    const right = rule.other != null ? record[rule.other] : rule.value
    // Skip when either operand is blank — a cross-field rule shouldn't fire on
    // half-filled data (the missing field's own Required rule handles that).
    if (isBlank(left) || (rule.other != null && isBlank(right))) continue
    if (!compareOp(rule.op, left, right, rule.as)) {
      add(rule.field, "cross-field", rule.message ?? `${rule.field} fails the ${rule.op} check.`)
    }
  }

  // 3) Business rules — named custom predicates supplied by the caller.
  for (const ref of schema.businessRules ?? []) {
    if (!evaluateCondition(ref.when, record)) continue
    const fn = opts.businessRules?.[ref.name]
    if (!fn) continue // an unregistered rule is a no-op, never a hard failure
    const outcome = fn(record, opts.ctx ?? {})
    if (outcome === true || (typeof outcome === "object" && outcome.ok)) continue
    const targets = ref.fields && ref.fields.length ? ref.fields : [FORM_FIELD]
    if (outcome.fieldErrors && Object.keys(outcome.fieldErrors).length) {
      for (const [f, m] of Object.entries(outcome.fieldErrors)) add(f, "business-rule", m)
    } else {
      const message = outcome.message ?? ref.message ?? `${ref.name} failed.`
      for (const t of targets) add(t, "business-rule", message)
    }
  }

  return finalize(issues)
}

function finalize(issues: ValidationIssue[]): ValidationResult {
  const fieldErrors: Record<string, string[]> = {}
  const firstErrors: Record<string, string> = {}
  for (const issue of issues) {
    ;(fieldErrors[issue.field] ??= []).push(issue.message)
    if (!(issue.field in firstErrors)) firstErrors[issue.field] = issue.message
  }
  return { ok: issues.length === 0, issues, fieldErrors, firstErrors }
}

// ---------------------------------------------------------------------------
// Small builder helpers — make declaring a schema terse and readable.
// ---------------------------------------------------------------------------

export const rule = {
  required: (message?: string): FieldRule => ({ type: "required", message }),
  format: (format: FormatName, message?: string): FieldRule => ({ type: "format", format, message }),
  pattern: (pattern: string, flags?: string, message?: string): FieldRule => ({ type: "pattern", pattern, flags, message }),
  length: (min?: number, max?: number, message?: string): FieldRule => ({ type: "length", min, max, message }),
  range: (min?: number, max?: number, message?: string): FieldRule => ({ type: "range", min, max, message }),
  dateRange: (min?: string, max?: string, message?: string): FieldRule => ({ type: "range", as: "date", min: min as unknown as number, max: max as unknown as number, message }),
  oneOf: (values: Array<string | number>, message?: string): FieldRule => ({ type: "enum", values, message }),
  unique: (scope?: string, message?: string): FieldRule => ({ type: "unique", scope, message }),
}

export function field(key: string, label: string, rules: FieldRule[], extra: Partial<FieldValidation> = {}): FieldValidation {
  return { key, label, rules, ...extra }
}
