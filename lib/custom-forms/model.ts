/**
 * SPEC 95 — Custom Forms: pure model (Phase 1 & 2).
 * ---------------------------------------------------------------------------
 * The metadata-driven, dependency-free core of the no-code custom-form engine.
 * It holds ZERO database access and no "server-only" marker so the SAME rules
 * drive the admin builder, the browser renderer, the API and the server, and
 * can be unit-tested exhaustively without a live DB (see
 * test/custom-forms-model.test.ts).
 *
 * A custom form is DATA, not code. An authorized admin describes a form — its
 * sections, the fields inside them, which fields are required, the help text
 * they carry, the conditions under which a field or section is shown, whether
 * submissions require approval — and the engine turns that description into
 * rendering, conditional visibility, validation and a submission/approval
 * workflow. Nothing about a form is hard-coded per module.
 *
 * Mirrors the sibling custom-FIELD engine (SPEC 94) deliberately: same
 * key-normalization, same "pure model + server store/service" split, same
 * fail-safe validation funnel.
 */
import { type TenantRole, tenantRank, toTenantRole } from "@/lib/role-model"

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------

export type FormFieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "boolean"
  | "dropdown"
  | "multiselect"
  | "email"
  | "url"
  | "phone"
  | "file"

export type FormFieldTypeDef = {
  type: FormFieldType
  label: string
  description: string
  /** dropdown / multiselect carry a fixed option list. */
  hasOptions: boolean
  /** multiselect / file may hold more than one value. */
  multiValue: boolean
  /** file fields capture an uploaded attachment (name + url). */
  isAttachment: boolean
}

export const FORM_FIELD_TYPES: readonly FormFieldTypeDef[] = [
  { type: "text", label: "Text", description: "A single line of free text.", hasOptions: false, multiValue: false, isAttachment: false },
  { type: "textarea", label: "Paragraph", description: "A multi-line block of text.", hasOptions: false, multiValue: false, isAttachment: false },
  { type: "number", label: "Number", description: "A numeric value with optional range.", hasOptions: false, multiValue: false, isAttachment: false },
  { type: "date", label: "Date", description: "A calendar date (ISO yyyy-mm-dd).", hasOptions: false, multiValue: false, isAttachment: false },
  { type: "boolean", label: "Checkbox", description: "A yes / no toggle.", hasOptions: false, multiValue: false, isAttachment: false },
  { type: "dropdown", label: "Dropdown", description: "Pick one value from a fixed list.", hasOptions: true, multiValue: false, isAttachment: false },
  { type: "multiselect", label: "Multi-select", description: "Pick any number of values from a fixed list.", hasOptions: true, multiValue: true, isAttachment: false },
  { type: "email", label: "Email", description: "A validated email address.", hasOptions: false, multiValue: false, isAttachment: false },
  { type: "url", label: "URL", description: "A validated web link.", hasOptions: false, multiValue: false, isAttachment: false },
  { type: "phone", label: "Phone", description: "A phone number.", hasOptions: false, multiValue: false, isAttachment: false },
  { type: "file", label: "Attachment", description: "An uploaded file (name + url).", hasOptions: false, multiValue: false, isAttachment: true },
] as const

const FIELD_TYPE_MAP = new Map<string, FormFieldTypeDef>(FORM_FIELD_TYPES.map((t) => [t.type, t]))

export function isFormFieldType(value: string): value is FormFieldType {
  return FIELD_TYPE_MAP.has(value)
}

export function getFormFieldTypeDef(type: string): FormFieldTypeDef | undefined {
  return FIELD_TYPE_MAP.get(type)
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type FieldOption = { value: string; label: string }

/** Comparison operators a conditional rule may use. */
export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "is_empty"
  | "is_not_empty"
  | "in"

export const CONDITION_OPERATORS: readonly { op: ConditionOperator; label: string; needsValue: boolean }[] = [
  { op: "equals", label: "equals", needsValue: true },
  { op: "not_equals", label: "does not equal", needsValue: true },
  { op: "contains", label: "contains", needsValue: true },
  { op: "not_contains", label: "does not contain", needsValue: true },
  { op: "gt", label: "greater than", needsValue: true },
  { op: "gte", label: "greater than or equal", needsValue: true },
  { op: "lt", label: "less than", needsValue: true },
  { op: "lte", label: "less than or equal", needsValue: true },
  { op: "in", label: "is one of (comma-separated)", needsValue: true },
  { op: "is_empty", label: "is empty", needsValue: false },
  { op: "is_not_empty", label: "is not empty", needsValue: false },
] as const

const OPERATOR_SET = new Set<string>(CONDITION_OPERATORS.map((o) => o.op))

export function isConditionOperator(value: string): value is ConditionOperator {
  return OPERATOR_SET.has(value)
}

export function operatorNeedsValue(op: ConditionOperator): boolean {
  return CONDITION_OPERATORS.find((o) => o.op === op)?.needsValue ?? true
}

/** A single conditional rule: "<field> <operator> <value>". */
export type Condition = {
  field: string
  operator: ConditionOperator
  value: string
}

/** A group of rules combined with all (AND) or any (OR). Empty = always show. */
export type ConditionGroup = {
  match: "all" | "any"
  rules: Condition[]
}

export type FieldConfig = {
  /** number: value bounds. */
  min?: number | null
  max?: number | null
  /** text / textarea: max characters. */
  maxLength?: number | null
  /** file: accepted mime/extension hint, informational only. */
  accept?: string | null
  placeholder?: string | null
}

export type FormField = {
  key: string
  label: string
  type: FormFieldType
  required: boolean
  helpText: string
  options: FieldOption[]
  config: FieldConfig
  defaultValue: unknown
  /** When present and non-empty, the field only shows when the group passes. */
  visibility: ConditionGroup | null
}

export type FormSection = {
  key: string
  title: string
  description: string
  /** When present and non-empty, the whole section shows only when it passes. */
  visibility: ConditionGroup | null
  fields: FormField[]
}

export type FormApproval = {
  enabled: boolean
  /** Minimum tenant role that may approve/reject a submission. */
  approverMinRole: TenantRole
}

export type FormStatus = "draft" | "published" | "archived"

export type FormDefinition = {
  id: number | null
  title: string
  slug: string
  description: string
  status: FormStatus
  submitLabel: string
  approval: FormApproval
  sections: FormSection[]
  version: number
}

// ---------------------------------------------------------------------------
// Key + slug + option normalization
// ---------------------------------------------------------------------------

/** A key/slug: lowercase, alnum + underscore, never leading digit. */
export function normalizeKey(key: string): string {
  let k = String(key ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")
  if (k && /^[0-9]/.test(k)) k = `f_${k}`
  return k
}

export function keyFromLabel(label: string): string {
  return normalizeKey(label)
}

/** A URL slug: lowercase, alnum + hyphen. */
export function normalizeSlug(slug: string): string {
  return String(slug ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
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

function normalizeConditionGroup(raw: unknown): ConditionGroup | null {
  if (!raw || typeof raw !== "object") return null
  const match = (raw as any).match === "any" ? "any" : "all"
  const rawRules = Array.isArray((raw as any).rules) ? (raw as any).rules : []
  const rules: Condition[] = []
  for (const r of rawRules) {
    if (!r || typeof r !== "object") continue
    const field = normalizeKey(String((r as any).field ?? ""))
    const op = String((r as any).operator ?? "")
    if (!field || !isConditionOperator(op)) continue
    rules.push({
      field,
      operator: op,
      value: operatorNeedsValue(op) ? String((r as any).value ?? "") : "",
    })
  }
  if (rules.length === 0) return null
  return { match, rules }
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
// Definition validation
// ---------------------------------------------------------------------------

export type FormDefInput = {
  id?: number | null
  title: string
  slug?: string
  description?: string
  status?: string
  submitLabel?: string
  approval?: { enabled?: boolean; approverMinRole?: string }
  sections?: unknown
  version?: number
}

function normalizeStatus(value: unknown): FormStatus {
  const s = String(value ?? "").toLowerCase()
  return s === "published" || s === "archived" ? s : "draft"
}

/**
 * Validate + normalize a raw form definition into a safe FormDefinition, or
 * return the collected reasons. The API and builder both funnel through here so
 * a bad form can never be persisted.
 *
 * The heart of the check is REFERENTIAL INTEGRITY for conditional logic: every
 * condition must reference a field key that actually exists elsewhere in the
 * form, and a field can never depend on itself. This is what keeps a complex
 * conditional form from ever pointing at a phantom field.
 */
export function validateFormDefinition(
  input: FormDefInput,
): { ok: true; def: FormDefinition } | { ok: false; errors: string[] } {
  const errors: string[] = []

  const title = String(input.title ?? "").trim()
  if (!title) errors.push("A form title is required.")
  if (title.length > 160) errors.push("Form title must be 160 characters or fewer.")

  const slug = normalizeSlug(input.slug || title)
  if (!slug) errors.push("Could not derive a valid slug from the title.")

  const rawSections = Array.isArray(input.sections) ? input.sections : []
  if (rawSections.length === 0) errors.push("A form needs at least one section.")

  const sections: FormSection[] = []
  const sectionKeys = new Set<string>()
  const fieldKeys = new Set<string>()
  // First pass: collect all field keys so a condition may reference any field
  // in the form (forward or backward), then validate references in a second pass.
  const rawFieldKeyList: string[] = []

  for (const rawSection of rawSections) {
    if (!rawSection || typeof rawSection !== "object") continue
    const s = rawSection as any
    for (const rawField of Array.isArray(s.fields) ? s.fields : []) {
      if (!rawField || typeof rawField !== "object") continue
      const fk = normalizeKey(String((rawField as any).key || keyFromLabel(String((rawField as any).label ?? ""))))
      if (fk) rawFieldKeyList.push(fk)
    }
  }
  const allFieldKeys = new Set(rawFieldKeyList)

  for (const rawSection of rawSections) {
    if (!rawSection || typeof rawSection !== "object") {
      errors.push("Each section must be an object.")
      continue
    }
    const s = rawSection as any
    const sTitle = String(s.title ?? "").trim()
    if (!sTitle) errors.push("Every section needs a title.")
    let sKey = normalizeKey(s.key || keyFromLabel(sTitle))
    if (!sKey) {
      errors.push(`Could not derive a key for section "${sTitle || "untitled"}".`)
      sKey = `section_${sections.length + 1}`
    }
    if (sectionKeys.has(sKey)) {
      errors.push(`Duplicate section key "${sKey}".`)
    }
    sectionKeys.add(sKey)

    const sVisibility = normalizeConditionGroup(s.visibility)
    validateConditionRefs(sVisibility, allFieldKeys, null, `Section "${sTitle}"`, errors)

    const fields: FormField[] = []
    for (const rawField of Array.isArray(s.fields) ? s.fields : []) {
      if (!rawField || typeof rawField !== "object") {
        errors.push(`Section "${sTitle}" has an invalid field.`)
        continue
      }
      const f = rawField as any
      const fLabel = String(f.label ?? "").trim()
      if (!fLabel) errors.push(`Every field in section "${sTitle}" needs a label.`)
      const fType = String(f.type ?? "")
      const typeDef = getFormFieldTypeDef(fType)
      if (!typeDef) {
        errors.push(`Field "${fLabel}" has an unknown type "${fType}".`)
      }
      let fKey = normalizeKey(f.key || keyFromLabel(fLabel))
      if (!fKey) {
        errors.push(`Could not derive a key for field "${fLabel || "untitled"}".`)
        fKey = `field_${fields.length + 1}`
      }
      if (fieldKeys.has(fKey)) {
        errors.push(`Duplicate field key "${fKey}" (field keys must be unique across the whole form).`)
      }
      fieldKeys.add(fKey)

      const options = normalizeOptions(f.options)
      if (typeDef?.hasOptions) {
        if (options.length === 0) errors.push(`${typeDef.label} field "${fLabel}" needs at least one option.`)
        if (options.length > 200) errors.push(`Field "${fLabel}" may not have more than 200 options.`)
      }

      const config: FieldConfig = {}
      if (fType === "number") {
        config.min = toNum(f.config?.min)
        config.max = toNum(f.config?.max)
        if (config.min != null && config.max != null && config.min > config.max) {
          errors.push(`Field "${fLabel}": minimum cannot be greater than maximum.`)
        }
      }
      if (fType === "text" || fType === "textarea") {
        config.maxLength = clampInt(f.config?.maxLength, 1, 20000)
      }
      if (fType === "file") {
        const accept = String(f.config?.accept ?? "").trim()
        config.accept = accept || null
      }
      const placeholder = String(f.config?.placeholder ?? "").trim()
      if (placeholder) config.placeholder = placeholder

      const visibility = normalizeConditionGroup(f.visibility)
      validateConditionRefs(visibility, allFieldKeys, fKey, `Field "${fLabel}"`, errors)

      fields.push({
        key: fKey,
        label: fLabel,
        type: (typeDef?.type ?? "text") as FormFieldType,
        required: f.required === true,
        helpText: String(f.helpText ?? "").trim(),
        options: typeDef?.hasOptions ? options : [],
        config,
        defaultValue: f.defaultValue ?? null,
        visibility,
      })
    }

    if (fields.length === 0) errors.push(`Section "${sTitle}" needs at least one field.`)

    sections.push({ key: sKey, title: sTitle, description: String(s.description ?? "").trim(), visibility: sVisibility, fields })
  }

  const approvalEnabled = input.approval?.enabled === true
  const approverMinRole = toTenantRole(input.approval?.approverMinRole ?? "tenant_admin")

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    def: {
      id: input.id ?? null,
      title,
      slug,
      description: String(input.description ?? "").trim(),
      status: normalizeStatus(input.status),
      submitLabel: String(input.submitLabel ?? "").trim() || "Submit",
      approval: { enabled: approvalEnabled, approverMinRole },
      sections,
      version: Number.isFinite(Number(input.version)) ? Number(input.version) : 1,
    },
  }
}

function validateConditionRefs(
  group: ConditionGroup | null,
  allFieldKeys: Set<string>,
  ownKey: string | null,
  label: string,
  errors: string[],
): void {
  if (!group) return
  for (const rule of group.rules) {
    if (ownKey && rule.field === ownKey) {
      errors.push(`${label}: a field's visibility cannot depend on itself.`)
      continue
    }
    if (!allFieldKeys.has(rule.field)) {
      errors.push(`${label}: condition references unknown field "${rule.field}".`)
    }
  }
}

// ---------------------------------------------------------------------------
// Conditional evaluation (the heart of the form engine)
// ---------------------------------------------------------------------------

function isBlank(value: unknown): boolean {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0)
}

/** Compare a stored value against a rule. Pure and total — never throws. */
export function evaluateCondition(rule: Condition, values: Record<string, unknown>): boolean {
  const raw = values[rule.field]

  switch (rule.operator) {
    case "is_empty":
      return isBlank(raw)
    case "is_not_empty":
      return !isBlank(raw)
  }

  if (rule.operator === "in") {
    const set = rule.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    const candidates = Array.isArray(raw) ? raw.map((v) => String(v).toLowerCase()) : [String(raw ?? "").toLowerCase()]
    return candidates.some((c) => set.includes(c))
  }

  if (rule.operator === "contains" || rule.operator === "not_contains") {
    const needle = rule.value.toLowerCase()
    const hay = Array.isArray(raw)
      ? raw.map((v) => String(v).toLowerCase())
      : [String(raw ?? "").toLowerCase()]
    const hit = hay.some((h) => h.includes(needle))
    return rule.operator === "contains" ? hit : !hit
  }

  if (rule.operator === "gt" || rule.operator === "gte" || rule.operator === "lt" || rule.operator === "lte") {
    const left = Number(Array.isArray(raw) ? NaN : raw)
    const right = Number(rule.value)
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false
    if (rule.operator === "gt") return left > right
    if (rule.operator === "gte") return left >= right
    if (rule.operator === "lt") return left < right
    return left <= right
  }

  // equals / not_equals — compare as strings, with boolean/array awareness.
  const target = rule.value
  let matches: boolean
  if (typeof raw === "boolean") {
    matches = String(raw) === target.toLowerCase()
  } else if (Array.isArray(raw)) {
    matches = raw.map((v) => String(v)).includes(target)
  } else {
    matches = String(raw ?? "") === target
  }
  return rule.operator === "equals" ? matches : !matches
}

/** A group with no rules always passes (unconditional). */
export function evaluateConditionGroup(group: ConditionGroup | null, values: Record<string, unknown>): boolean {
  if (!group || group.rules.length === 0) return true
  if (group.match === "any") return group.rules.some((r) => evaluateCondition(r, values))
  return group.rules.every((r) => evaluateCondition(r, values))
}

export function isSectionVisible(section: FormSection, values: Record<string, unknown>): boolean {
  return evaluateConditionGroup(section.visibility, values)
}

/**
 * A field is visible only when BOTH its own visibility group AND its parent
 * section's group pass. A field in a hidden section is itself hidden.
 */
export function isFieldVisible(section: FormSection, field: FormField, values: Record<string, unknown>): boolean {
  return isSectionVisible(section, values) && evaluateConditionGroup(field.visibility, values)
}

/** Every field currently visible for the supplied values, flattened. */
export function visibleFields(form: FormDefinition, values: Record<string, unknown>): FormField[] {
  const out: FormField[] = []
  for (const section of form.sections) {
    if (!isSectionVisible(section, values)) continue
    for (const field of section.fields) {
      if (evaluateConditionGroup(field.visibility, values)) out.push(field)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Value validation
// ---------------------------------------------------------------------------

export type ValueOk = { ok: true; value: unknown }
export type ValueErr = { ok: false; error: string }
export type ValueResult = ValueOk | ValueErr

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^[+0-9][0-9\s()\-.]{4,}$/

/** Validate + coerce one raw value against a field definition. Pure — no I/O. */
export function validateFieldValue(field: FormField, rawValue: unknown): ValueResult {
  const typeDef = getFormFieldTypeDef(field.type)
  if (!typeDef) return { ok: false, error: "Unknown field type." }

  if (isBlank(rawValue)) {
    if (field.required) return { ok: false, error: `${field.label} is required.` }
    return { ok: true, value: null }
  }

  switch (field.type) {
    case "text":
    case "textarea": {
      const s = String(rawValue)
      const max = field.config.maxLength ?? (field.type === "textarea" ? 20000 : 10000)
      if (s.length > max) return { ok: false, error: `${field.label} must be ${max} characters or fewer.` }
      return { ok: true, value: s }
    }
    case "email": {
      const s = String(rawValue).trim()
      if (!EMAIL_RE.test(s)) return { ok: false, error: `${field.label} must be a valid email address.` }
      return { ok: true, value: s }
    }
    case "phone": {
      const s = String(rawValue).trim()
      if (!PHONE_RE.test(s)) return { ok: false, error: `${field.label} must be a valid phone number.` }
      return { ok: true, value: s }
    }
    case "url": {
      const s = String(rawValue).trim()
      try {
        const u = new URL(s)
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          return { ok: false, error: `${field.label} must be an http(s) URL.` }
        }
        return { ok: true, value: u.toString() }
      } catch {
        return { ok: false, error: `${field.label} must be a valid URL.` }
      }
    }
    case "number": {
      const n = Number(rawValue)
      if (!Number.isFinite(n)) return { ok: false, error: `${field.label} must be a number.` }
      if (field.config.min != null && n < field.config.min) {
        return { ok: false, error: `${field.label} must be at least ${field.config.min}.` }
      }
      if (field.config.max != null && n > field.config.max) {
        return { ok: false, error: `${field.label} must be at most ${field.config.max}.` }
      }
      return { ok: true, value: n }
    }
    case "date": {
      const s = String(rawValue).trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return { ok: false, error: `${field.label} must be a date (yyyy-mm-dd).` }
      }
      const d = new Date(`${s}T00:00:00Z`)
      if (Number.isNaN(d.getTime())) return { ok: false, error: `${field.label} is not a valid date.` }
      return { ok: true, value: s }
    }
    case "boolean": {
      if (typeof rawValue === "boolean") return { ok: true, value: rawValue }
      const s = String(rawValue).toLowerCase()
      if (["true", "1", "yes", "on"].includes(s)) return { ok: true, value: true }
      if (["false", "0", "no", "off"].includes(s)) return { ok: true, value: false }
      return { ok: false, error: `${field.label} must be true or false.` }
    }
    case "dropdown": {
      const s = String(rawValue)
      if (!field.options.some((o) => o.value === s)) {
        return { ok: false, error: `"${s}" is not a valid option for ${field.label}.` }
      }
      return { ok: true, value: s }
    }
    case "multiselect": {
      const arr = Array.isArray(rawValue) ? rawValue.map(String) : [String(rawValue)]
      const valid = new Set(field.options.map((o) => o.value))
      const unique: string[] = []
      for (const v of arr) {
        if (!valid.has(v)) return { ok: false, error: `"${v}" is not a valid option for ${field.label}.` }
        if (!unique.includes(v)) unique.push(v)
      }
      return { ok: true, value: unique }
    }
    case "file": {
      if (typeof rawValue === "string") {
        const s = rawValue.trim()
        if (!s) return { ok: false, error: `${field.label} is required.` }
        return { ok: true, value: { name: s.split("/").pop() || s, url: s } }
      }
      if (rawValue && typeof rawValue === "object") {
        const url = String((rawValue as any).url ?? "").trim()
        if (!url) return { ok: false, error: `${field.label} needs a file url.` }
        const name = String((rawValue as any).name ?? url.split("/").pop() ?? "file")
        const size = Number((rawValue as any).size)
        return { ok: true, value: { name, url, size: Number.isFinite(size) ? size : null } }
      }
      return { ok: false, error: `${field.label} must be a file.` }
    }
    default:
      return { ok: false, error: "Unsupported field type." }
  }
}

export type SubmissionValidation =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> }

/**
 * Validate a whole submission against a form.
 *
 * The defining behaviour of a CONDITIONAL form: only fields that are currently
 * VISIBLE (given the submitted values) are validated and required. A required
 * field that is hidden by its own or its section's condition is neither
 * required nor stored — you can never be blocked by, or leak a value into, a
 * field the responder was never shown. Values for hidden fields are dropped.
 */
export function validateSubmission(
  form: FormDefinition,
  input: Record<string, unknown>,
): SubmissionValidation {
  const errors: Record<string, string> = {}
  const clean: Record<string, unknown> = {}

  const visible = visibleFields(form, input)
  const visibleByKey = new Map(visible.map((f) => [f.key, f]))

  // Validate every visible field (required + type/shape).
  for (const field of visible) {
    const result = validateFieldValue(field, input[field.key])
    if (!result.ok) {
      errors[field.key] = result.error
      continue
    }
    if (result.value != null) clean[field.key] = result.value
  }

  // Values submitted for fields that are NOT currently visible are silently
  // discarded (they must never be persisted or block submission).
  void visibleByKey

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, values: clean }
}

// ---------------------------------------------------------------------------
// Submission workflow (state machine)
// ---------------------------------------------------------------------------
//
// draft ──submit──▶ submitted           (approval disabled: terminal, accepted)
// draft ──submit──▶ pending ──approve──▶ approved
//                          └──reject───▶ rejected ──resubmit──▶ pending
//
// The state a submit lands in depends purely on whether the form requires
// approval. Only an approver (a role at/above the form's approverMinRole) may
// move a submission out of `pending`.

export type SubmissionStatus = "draft" | "submitted" | "pending" | "approved" | "rejected"

export const SUBMISSION_STATUSES: readonly SubmissionStatus[] = [
  "draft",
  "submitted",
  "pending",
  "approved",
  "rejected",
] as const

export function isSubmissionStatus(value: string): value is SubmissionStatus {
  return (SUBMISSION_STATUSES as readonly string[]).includes(value)
}

/** Where a submit lands, given the form's approval requirement. */
export function statusOnSubmit(approvalEnabled: boolean): SubmissionStatus {
  return approvalEnabled ? "pending" : "submitted"
}

/** A submission awaiting an approver decision. */
export function isAwaitingApproval(status: SubmissionStatus): boolean {
  return status === "pending"
}

/** Terminal states cannot transition further (except an explicit resubmit). */
export function isTerminal(status: SubmissionStatus): boolean {
  return status === "submitted" || status === "approved"
}

export type ReviewDecision = "approve" | "reject"

/**
 * Apply an approver decision. Only a `pending` submission can be reviewed; only
 * a role at/above the form's approver role may do so. Returns the next status
 * or a reason it was refused.
 */
export function applyReview(
  status: SubmissionStatus,
  decision: ReviewDecision,
  approval: FormApproval,
  reviewerRole: TenantRole,
): { ok: true; status: SubmissionStatus } | { ok: false; error: string } {
  if (!approval.enabled) return { ok: false, error: "This form does not require approval." }
  if (status !== "pending") return { ok: false, error: `A ${status} submission cannot be reviewed.` }
  if (tenantRank(reviewerRole) < tenantRank(approval.approverMinRole)) {
    return { ok: false, error: "You do not have permission to review this submission." }
  }
  return { ok: true, status: decision === "approve" ? "approved" : "rejected" }
}

/** Whether a role may review submissions for a form. */
export function canReview(approval: FormApproval, role: TenantRole): boolean {
  return approval.enabled && tenantRank(role) >= tenantRank(approval.approverMinRole)
}

export function submissionStatusLabel(status: SubmissionStatus): string {
  switch (status) {
    case "draft":
      return "Draft"
    case "submitted":
      return "Submitted"
    case "pending":
      return "Pending approval"
    case "approved":
      return "Approved"
    case "rejected":
      return "Rejected"
  }
}
