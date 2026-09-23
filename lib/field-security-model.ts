/**
 * Field-Level Security (pure model).
 * ---------------------------------------------------------------------------
 * The deterministic, dependency-free core of field-level security. It answers
 * one question with no I/O: "given the policies that touch a field and the
 * actor asking for it, what should happen to that field's value?"
 *
 * Where (Data Classification) is a CLEARANCE model — a field carries a
 * sensitivity level and a role must be cleared to that level to see it —
 * is a targeted RESTRICTION model layered on top: named policies mask/hide/lock
 * individual sensitive fields (salary, bank account, PAN, Aadhaar, tax, personal
 * identifiers, internal financials) for a defined audience (a role and below, a
 * department, a legal entity, or a permission group). A field with no matching
 * policy is fully visible; policies only ever take visibility away.
 *
 * Everything here is pure so it can be unit-tested exhaustively and reused
 * verbatim on every enforcement surface — API reads, UI, exports, reports —
 * because a field-security decision must be identical wherever data leaves the
 * system (Phase 3). The server store (lib/field-security.ts) supplies the
 * policies; this module decides and applies the effect.
 */
import { type TenantRole, tenantRank, toTenantRole } from "@/lib/role-model"

// ---------------------------------------------------------------------------
// Effects — what a matching policy does to a field's value.
// ---------------------------------------------------------------------------

export const FIELD_EFFECTS = ["visible", "read_only", "masked", "hidden"] as const
export type FieldEffect = (typeof FIELD_EFFECTS)[number]

// Ordered least → most restrictive. When several policies match one field the
// MOST restrictive effect always wins, so overlapping rules can never widen
// access by accident (fail-safe composition).
const EFFECT_RANK: Record<FieldEffect, number> = {
  visible: 0,
  read_only: 1,
  masked: 2,
  hidden: 3,
}

export function toFieldEffect(value: unknown): FieldEffect {
  return FIELD_EFFECTS.includes(value as FieldEffect) ? (value as FieldEffect) : "masked"
}

/** The more restrictive of two effects (ties return `a`). */
export function moreRestrictiveEffect(a: FieldEffect, b: FieldEffect): FieldEffect {
  return EFFECT_RANK[b] > EFFECT_RANK[a] ? b : a
}

/** A read surface (API/export/report) must redact both masked and hidden. */
export function effectRedactsValue(effect: FieldEffect): boolean {
  return effect === "masked" || effect === "hidden"
}

// ---------------------------------------------------------------------------
// Sensitive-field catalog (Phase 1) — the categories the spec calls out, each
// with a masking strategy appropriate to the data. The category drives HOW a
// value is masked (reveal the last few chars of an account, but never any of a
// salary) and documents WHY a field is sensitive.
// ---------------------------------------------------------------------------

export const SENSITIVE_CATEGORIES = [
  "salary",
  "bank_account",
  "pan",
  "aadhaar",
  "tax",
  "personal_identifier",
  "financial",
  "generic",
] as const
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number]

export const CATEGORY_META: Record<SensitiveCategory, { label: string; description: string }> = {
  salary: { label: "Salary / compensation", description: "CTC, gross/net pay, bonuses, pay slips." },
  bank_account: { label: "Bank account", description: "Account number, IFSC/SWIFT, UPI, routing details." },
  pan: { label: "PAN", description: "Permanent Account Number and other tax IDs." },
  aadhaar: {
    label: "Aadhaar (where permitted)",
    description: "Aadhaar / national ID numbers, only where legally permissible.",
  },
  tax: { label: "Tax information", description: "TDS, tax declarations, filing and assessment details." },
  personal_identifier: {
    label: "Personal identifier",
    description: "Date of birth, personal phone/email, home address, emergency contacts.",
  },
  financial: {
    label: "Internal financial",
    description: "Margins, cost prices, internal valuations and other confidential financials.",
  },
  generic: { label: "Other sensitive", description: "Any other field designated sensitive by policy." },
}

export function toSensitiveCategory(value: unknown): SensitiveCategory {
  return SENSITIVE_CATEGORIES.includes(value as SensitiveCategory) ? (value as SensitiveCategory) : "generic"
}

// ---------------------------------------------------------------------------
// Masking — deterministic, never reversible, never length-leaking for money.
// ---------------------------------------------------------------------------

const FULL_MASK = "••••••"

/** Replace every character except the last `keep` with `char` (preserving length). */
function keepLast(value: string, keep: number, char: string): string {
  if (value.length <= keep) return char.repeat(value.length)
  return char.repeat(value.length - keep) + value.slice(value.length - keep)
}

/**
 * Mask a value for its category. Returns a display-safe string:
 *  - money / internal financials → fixed-width bullets (never reveal magnitude)
 *  - account / PAN / Aadhaar / tax → reveal only the last few characters
 *  - personal identifiers → reveal the last two characters
 * A null/empty value is returned unchanged (nothing to hide).
 */
export function maskValue(value: unknown, category: SensitiveCategory): string | null {
  if (value == null) return value as null
  const s = String(value)
  if (s.trim() === "") return s
  switch (category) {
    case "salary":
    case "financial":
      return FULL_MASK
    case "bank_account":
      return keepLast(s, 4, "•")
    case "pan":
    case "tax":
      return keepLast(s, 4, "X")
    case "aadhaar":
      return keepLast(s, 4, "X")
    case "personal_identifier":
      return keepLast(s, 2, "•")
    default:
      return FULL_MASK
  }
}

// ---------------------------------------------------------------------------
// Scope — WHO a policy applies to.
// ---------------------------------------------------------------------------

export const FIELD_SCOPE_TYPES = ["everyone", "role", "department", "legal_entity", "permission_group"] as const
export type FieldScopeType = (typeof FIELD_SCOPE_TYPES)[number]

export const SCOPE_TYPE_META: Record<FieldScopeType, { label: string; hint: string }> = {
  everyone: { label: "Everyone", hint: "Applies to every user in the tenant." },
  role: { label: "Role and below", hint: "Applies to this tenant role and every less-privileged role." },
  department: { label: "Department", hint: "Applies to users in this department (exact match)." },
  legal_entity: { label: "Legal entity", hint: "Applies to users in this legal entity (exact match)." },
  permission_group: { label: "Permission group", hint: "Applies to users in this permission group." },
}

export function toFieldScopeType(value: unknown): FieldScopeType {
  return FIELD_SCOPE_TYPES.includes(value as FieldScopeType) ? (value as FieldScopeType) : "everyone"
}

/** A single field-security rule, as consumed by the pure resolver. */
export type FieldPolicyRule = {
  field: string
  category: SensitiveCategory
  scopeType: FieldScopeType
  scopeValue: string
  effect: FieldEffect
  enabled: boolean
}

/**
 * The attributes of the actor a policy is matched against. `role` is always
 * known from the verified session; the optional attributes are supplied by the
 * calling surface when it can resolve them. A scope whose attribute is unknown
 * simply does not match (role- and everyone-scoped policies still apply), which
 * is the documented limitation of attribute-based scopes.
 */
export type FieldSecurityActor = {
  role: TenantRole
  department?: string | null
  legalEntityId?: string | number | null
  permissionGroups?: string[]
}

function norm(value: unknown): string {
  return String(value ?? "").trim().toLowerCase()
}

/** Does this rule apply to this actor? */
export function policyMatchesActor(rule: FieldPolicyRule, actor: FieldSecurityActor): boolean {
  if (!rule.enabled) return false
  switch (rule.scopeType) {
    case "everyone":
      return true
    case "role":
      // "This role and below": a policy restricting `module_admin` also
      // restricts `employee`, but never a more-privileged `tenant_admin`.
      return tenantRank(actor.role) <= tenantRank(toTenantRole(rule.scopeValue))
    case "department":
      return actor.department != null && norm(actor.department) === norm(rule.scopeValue)
    case "legal_entity":
      return actor.legalEntityId != null && norm(actor.legalEntityId) === norm(rule.scopeValue)
    case "permission_group":
      return (actor.permissionGroups ?? []).some((g) => norm(g) === norm(rule.scopeValue))
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Resolution + application (Phase 2 core).
// ---------------------------------------------------------------------------

export type ResolvedFieldEffect = { effect: FieldEffect; category: SensitiveCategory }

/**
 * Collapse all rules for an entity into one decision per field for this actor.
 * Only fields with a non-`visible` outcome are returned. When several rules hit
 * the same field the most restrictive effect wins, and that rule's category is
 * used for masking.
 */
export function resolveFieldEffects(
  rules: FieldPolicyRule[],
  actor: FieldSecurityActor,
): Map<string, ResolvedFieldEffect> {
  const out = new Map<string, ResolvedFieldEffect>()
  for (const rule of rules) {
    if (!policyMatchesActor(rule, actor)) continue
    const prev = out.get(rule.field)
    if (!prev) {
      out.set(rule.field, { effect: rule.effect, category: rule.category })
    } else {
      const winner = moreRestrictiveEffect(prev.effect, rule.effect)
      out.set(rule.field, {
        effect: winner,
        // Keep the category of whichever rule owns the winning effect.
        category: winner === rule.effect ? rule.category : prev.category,
      })
    }
  }
  // Drop no-op `visible` outcomes so callers can treat the map as "restrictions".
  for (const [field, resolved] of out) if (resolved.effect === "visible") out.delete(field)
  return out
}

export type AppliedFieldEffect = { field: string; effect: FieldEffect; category: SensitiveCategory }

/**
 * Apply resolved effects to one record. Returns a NEW object (never mutates the
 * input) plus the list of effects actually applied (for audit / UI hints):
 *   hidden   → the key is removed entirely
 *   masked   → the value is replaced with a category-appropriate mask
 *   read_only→ value is untouched here (a write-time concern); reported so the
 *              UI can render the field as non-editable.
 * Fields absent from the record are ignored.
 */
export function applyFieldSecurityToRow<T extends Record<string, unknown>>(
  row: T,
  effects: Map<string, ResolvedFieldEffect>,
): { row: Partial<T>; applied: AppliedFieldEffect[] } {
  if (effects.size === 0) return { row: { ...row }, applied: [] }
  const copy: Partial<T> = { ...row }
  const applied: AppliedFieldEffect[] = []
  for (const [field, { effect, category }] of effects) {
    if (!(field in copy)) continue
    if (effect === "hidden") {
      delete copy[field as keyof T]
    } else if (effect === "masked") {
      copy[field as keyof T] = maskValue(copy[field as keyof T], category) as T[keyof T]
    }
    applied.push({ field, effect, category })
  }
  return { row: copy, applied }
}
