// =============================================================
// SPEC 9 — Attribute-Based Access Control (ABAC): pure model + engine
// -------------------------------------------------------------
// RBAC (SPEC 8) answers "does this ROLE grant this action on this module?".
// ABAC answers a second, orthogonal question: "given the ATTRIBUTES of the
// acting user, the record being touched, and the environment, is this specific
// access permitted?".  It is the layer that expresses rules like:
//
//   * "A branch manager may only edit records in their OWN branch."
//   * "Expenses above ₹50,000 may only be approved by employee level ≥ 4."
//   * "Confidential documents are visible only to users with matching or
//      higher data-classification clearance."
//   * "A manager may view records owned by anyone in their management chain."
//
// These cut ACROSS modules and cannot be captured by a role's module matrix,
// because they depend on the *values* of attributes at evaluation time.
//
// This file is deliberately free of any DB / server-only import so the whole
// engine can be unit-tested directly (see test/abac-policy.test.ts) and the
// attribute catalog can be imported by client components. Persistence lives in
// lib/abac-store.ts and enforcement wiring in lib/abac-enforce.ts.
// =============================================================

// -------------------------------------------------------------------------
// Phase 1 — the supported attributes.
// -------------------------------------------------------------------------

/** The canonical attribute keys ABAC policies may reference. */
export const ABAC_ATTRIBUTES = [
  "department",
  "branch",
  "entity",
  "location",
  "manager_chain",
  "employee_level",
  "data_classification",
  "amount",
  "project",
  "cost_center",
  "geography",
] as const

export type AbacAttributeKey = (typeof ABAC_ATTRIBUTES)[number]

/** Where an attribute can be sourced from during evaluation. */
export type AbacTarget = "subject" | "resource" | "environment"

/**
 * The value kinds an attribute carries. `ordinal` attributes (clearance,
 * seniority) support gt/gte/lt/lte through a named rank scale; `set` attributes
 * hold multiple values (e.g. the branches a regional manager oversees, or the
 * user-ids in a manager's reporting chain) and are the right-hand side of
 * `in` / `contains` membership tests.
 */
export type AbacAttributeKind = "string" | "number" | "ordinal" | "set"

export type AbacAttributeDef = {
  key: AbacAttributeKey
  label: string
  kind: AbacAttributeKind
  /** Which targets this attribute is meaningful on (drives the UI pickers). */
  targets: AbacTarget[]
  description: string
  /** For `ordinal` attributes, the low→high ranking used by gt/gte/lt/lte. */
  ordinalScale?: string[]
}

/**
 * Ordinal scales. Comparisons on these attributes map each side through the
 * scale (case-insensitive) BEFORE comparing, so "confidential" > "internal"
 * and a level-5 "senior" outranks a level-2 "junior" regardless of the raw
 * string. Unknown values fall back to numeric parsing, then to rank -1 (which
 * makes any ordinal comparison against them false — fail-safe).
 */
export const DATA_CLASSIFICATION_SCALE = ["public", "internal", "confidential", "restricted", "secret"] as const
export const EMPLOYEE_LEVEL_SCALE = [
  "intern",
  "junior",
  "associate",
  "mid",
  "senior",
  "lead",
  "manager",
  "director",
  "vp",
  "c_level",
] as const

export const ABAC_ATTRIBUTE_CATALOG: AbacAttributeDef[] = [
  { key: "department", label: "Department", kind: "string", targets: ["subject", "resource"], description: "Organizational department the user belongs to / the record is filed under." },
  { key: "branch", label: "Branch", kind: "string", targets: ["subject", "resource"], description: "Physical or organizational branch." },
  { key: "entity", label: "Legal Entity", kind: "string", targets: ["subject", "resource"], description: "The legal/booking entity that owns the record." },
  { key: "location", label: "Location", kind: "string", targets: ["subject", "resource", "environment"], description: "Office / site location." },
  { key: "manager_chain", label: "Manager Hierarchy", kind: "set", targets: ["subject"], description: "The set of user-ids in the acting user's downward management chain — used to grant access to subordinates' records." },
  { key: "employee_level", label: "Employee Level", kind: "ordinal", targets: ["subject", "resource"], description: "Seniority band. Supports ≥ / ≤ comparisons via a named scale.", ordinalScale: [...EMPLOYEE_LEVEL_SCALE] },
  { key: "data_classification", label: "Data Classification", kind: "ordinal", targets: ["subject", "resource"], description: "Sensitivity label. On a subject this is their clearance; on a resource its classification.", ordinalScale: [...DATA_CLASSIFICATION_SCALE] },
  { key: "amount", label: "Amount", kind: "number", targets: ["resource"], description: "Monetary amount on the record, for threshold rules." },
  { key: "project", label: "Project", kind: "string", targets: ["subject", "resource"], description: "Project the record belongs to / the user is assigned to." },
  { key: "cost_center", label: "Cost Center", kind: "string", targets: ["subject", "resource"], description: "Accounting cost center." },
  { key: "geography", label: "Geography", kind: "string", targets: ["subject", "resource", "environment"], description: "Region / country / territory." },
]

const CATALOG_BY_KEY: Record<string, AbacAttributeDef> = Object.fromEntries(
  ABAC_ATTRIBUTE_CATALOG.map((a) => [a.key, a]),
)

export function getAbacAttribute(key: string): AbacAttributeDef | undefined {
  return CATALOG_BY_KEY[key]
}

/**
 * The standardized action vocabulary a policy can be scoped to. Mirrors the
 * SPEC 8 action taxonomy (CRUD + the extended verbs) so an ABAC policy and an
 * RBAC grant speak the same action language. "*" matches every action.
 */
export const ABAC_ACTIONS = [
  "view",
  "create",
  "edit",
  "delete",
  "approve",
  "reject",
  "export",
  "import",
  "download",
  "email",
  "configuration",
  "admin",
] as const
export type AbacAction = (typeof ABAC_ACTIONS)[number]

// -------------------------------------------------------------------------
// Phase 2 — the policy shape + evaluation engine.
// -------------------------------------------------------------------------

export type AttrValue = string | number | boolean
export type AttributeBag = Record<string, AttrValue | AttrValue[] | null | undefined>

export type AbacEvalContext = {
  subject: AttributeBag
  resource: AttributeBag
  environment?: AttributeBag
}

export const ABAC_OPERATORS = ["eq", "ne", "in", "not_in", "gt", "gte", "lt", "lte", "contains", "not_contains"] as const
export type AbacOperator = (typeof ABAC_OPERATORS)[number]

/**
 * The right-hand operand of a condition. Either a fixed literal, or a REFERENCE
 * to another attribute resolved from the context at evaluation time. The
 * attribute-reference form is what makes ABAC dynamic — e.g. comparing
 * `resource.department` to `subject.department` for a "same department" rule
 * without hard-coding the department.
 */
export type AbacOperand =
  | { kind: "literal"; value: AttrValue | AttrValue[] }
  | { kind: "attribute"; target: AbacTarget; attribute: string }

export type AbacCondition = {
  /** Which side of the context supplies the attribute under test. */
  target: AbacTarget
  attribute: string
  operator: AbacOperator
  operand: AbacOperand
}

export type AbacEffect = "permit" | "deny"

export type AbacPolicy = {
  id: number | string
  name: string
  description?: string | null
  effect: AbacEffect
  /** Higher wins under the `priority` / `first-applicable` algorithms. */
  priority: number
  enabled: boolean
  /** Module keys this policy governs. Supports exact, "group.*", and "*". */
  modules: string[]
  /** Actions this policy governs (see ABAC_ACTIONS). Supports "*". */
  actions: string[]
  /** How the conditions combine. Defaults to "all" (AND). */
  combine?: "all" | "any"
  conditions: AbacCondition[]
}

export type AbacRequest = {
  module: string
  action: string
}

export type AbacDecision = "permit" | "deny" | "not_applicable"

/**
 * How conflicting matched policies are resolved. These mirror the classic
 * XACML combining algorithms and are the heart of SPEC 9 Phase 4:
 *   - deny-overrides   : any matched deny wins over any permit (default, safest)
 *   - permit-overrides : any matched permit wins over any deny
 *   - priority         : the highest-priority matched policy decides; ties break
 *                        deny-over-permit
 *   - first-applicable : policies are ordered by priority desc (then id) and the
 *                        first matched policy decides
 */
export type AbacCombiningAlgorithm = "deny-overrides" | "permit-overrides" | "priority" | "first-applicable"

export type AbacEvaluationResult = {
  decision: AbacDecision
  /** The policy that determined the decision (null when not applicable). */
  decidingPolicy: AbacPolicy | null
  /** Every policy that matched the request + conditions, in evaluation order. */
  matched: AbacPolicy[]
  reason: string
}

// -------------------------------------------------------------------------
// Scope matching (module / action).
// -------------------------------------------------------------------------

/** Whether a policy pattern list matches a concrete value (supports "*" and "group.*"). */
function patternMatches(patterns: string[], value: string): boolean {
  for (const raw of patterns) {
    const p = raw.trim()
    if (p === "*") return true
    if (p === value) return true
    if (p.endsWith(".*")) {
      const prefix = p.slice(0, -2)
      if (value === prefix || value.startsWith(prefix + ".")) return true
    }
  }
  return false
}

export function policyAppliesToRequest(policy: AbacPolicy, req: AbacRequest): boolean {
  if (!policy.enabled) return false
  const modOk = policy.modules.length === 0 ? true : patternMatches(policy.modules, req.module)
  const actOk = policy.actions.length === 0 ? true : patternMatches(policy.actions, req.action)
  return modOk && actOk
}

// -------------------------------------------------------------------------
// Value resolution + comparison.
// -------------------------------------------------------------------------

function bagFor(ctx: AbacEvalContext, target: AbacTarget): AttributeBag {
  if (target === "subject") return ctx.subject
  if (target === "resource") return ctx.resource
  return ctx.environment ?? {}
}

function resolveOperand(operand: AbacOperand, ctx: AbacEvalContext): AttrValue | AttrValue[] | null | undefined {
  if (operand.kind === "literal") return operand.value
  return bagFor(ctx, operand.target)[operand.attribute]
}

/** Rank an ordinal value through its scale (case-insensitive). Returns -1 when unknown. */
function ordinalRank(attribute: string, value: AttrValue): number {
  const def = CATALOG_BY_KEY[attribute]
  const scale = def?.ordinalScale
  if (scale) {
    const idx = scale.findIndex((s) => s.toLowerCase() === String(value).toLowerCase())
    if (idx >= 0) return idx
  }
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : -1
}

function toComparableNumber(attribute: string, value: AttrValue | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const def = CATALOG_BY_KEY[attribute]
  if (def?.kind === "ordinal") {
    const r = ordinalRank(attribute, value)
    return r < 0 ? null : r
  }
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function asArray(v: AttrValue | AttrValue[] | null | undefined): AttrValue[] {
  if (v === null || v === undefined) return []
  return Array.isArray(v) ? v : [v]
}

function looseEquals(a: AttrValue, b: AttrValue): boolean {
  // Compare case-insensitively for strings, value-wise for numbers/booleans.
  if (typeof a === "string" || typeof b === "string") {
    return String(a).toLowerCase() === String(b).toLowerCase()
  }
  return a === b
}

/**
 * Evaluate a single condition against the context. A missing attribute under
 * test yields `false` for every operator (deterministic + fail-safe): a policy
 * can never match on data that isn't there.
 */
export function evaluateCondition(cond: AbacCondition, ctx: AbacEvalContext): boolean {
  const left = bagFor(ctx, cond.target)[cond.attribute]
  const right = resolveOperand(cond.operand, ctx)

  switch (cond.operator) {
    case "eq":
      if (left === null || left === undefined || right === null || right === undefined) return false
      if (Array.isArray(left) || Array.isArray(right)) return false
      return looseEquals(left, right)
    case "ne":
      // Absent left is treated as "not equal" only when the right is present.
      if (right === null || right === undefined) return false
      if (left === null || left === undefined) return true
      if (Array.isArray(left) || Array.isArray(right)) return true
      return !looseEquals(left, right)
    case "in": {
      // left ∈ right(set)
      if (left === null || left === undefined) return false
      const set = asArray(right)
      const leftVals = asArray(left)
      return leftVals.some((lv) => set.some((rv) => looseEquals(lv, rv)))
    }
    case "not_in": {
      if (left === null || left === undefined) return false
      const set = asArray(right)
      const leftVals = asArray(left)
      return !leftVals.some((lv) => set.some((rv) => looseEquals(lv, rv)))
    }
    case "contains": {
      // left(set/string) contains right(scalar)
      if (left === null || left === undefined || right === null || right === undefined) return false
      if (Array.isArray(left)) {
        const needles = asArray(right)
        return needles.every((rv) => left.some((lv) => looseEquals(lv, rv)))
      }
      return String(left).toLowerCase().includes(String(right).toLowerCase())
    }
    case "not_contains": {
      if (left === null || left === undefined) return true
      if (right === null || right === undefined) return true
      if (Array.isArray(left)) {
        const needles = asArray(right)
        return !needles.some((rv) => left.some((lv) => looseEquals(lv, rv)))
      }
      return !String(left).toLowerCase().includes(String(right).toLowerCase())
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (Array.isArray(left) || Array.isArray(right)) return false
      const l = toComparableNumber(cond.attribute, left as AttrValue)
      // The right operand ranks against the SAME attribute's scale so an
      // ordinal literal ("confidential") compares correctly.
      const r =
        cond.operand.kind === "attribute"
          ? toComparableNumber(cond.operand.attribute, right as AttrValue)
          : toComparableNumber(cond.attribute, right as AttrValue)
      if (l === null || r === null) return false
      if (cond.operator === "gt") return l > r
      if (cond.operator === "gte") return l >= r
      if (cond.operator === "lt") return l < r
      return l <= r
    }
    default:
      return false
  }
}

/** Whether every/any condition of a policy holds for the context. */
export function policyConditionsMatch(policy: AbacPolicy, ctx: AbacEvalContext): boolean {
  if (policy.conditions.length === 0) return true // an unconditional policy always matches its scope
  const combine = policy.combine ?? "all"
  if (combine === "any") return policy.conditions.some((c) => evaluateCondition(c, ctx))
  return policy.conditions.every((c) => evaluateCondition(c, ctx))
}

/** Stable ordering: priority desc, then id asc (numeric-aware). */
function byPriorityThenId(a: AbacPolicy, b: AbacPolicy): number {
  if (b.priority !== a.priority) return b.priority - a.priority
  return String(a.id).localeCompare(String(b.id), undefined, { numeric: true })
}

/**
 * The core engine (Phase 2). Selects applicable+matching policies and resolves
 * their combined decision under the chosen algorithm. Returns
 * `not_applicable` when no policy matches, so the caller can apply its own
 * default (see `resolveDecision`).
 */
export function evaluatePolicies(
  policies: AbacPolicy[],
  req: AbacRequest,
  ctx: AbacEvalContext,
  algorithm: AbacCombiningAlgorithm = "deny-overrides",
): AbacEvaluationResult {
  const matched = policies
    .filter((p) => policyAppliesToRequest(p, req) && policyConditionsMatch(p, ctx))
    .sort(byPriorityThenId)

  if (matched.length === 0) {
    return { decision: "not_applicable", decidingPolicy: null, matched, reason: "No policy matched the request." }
  }

  const permits = matched.filter((p) => p.effect === "permit")
  const denies = matched.filter((p) => p.effect === "deny")

  switch (algorithm) {
    case "permit-overrides": {
      if (permits.length > 0) {
        return { decision: "permit", decidingPolicy: permits[0], matched, reason: `Permitted by "${permits[0].name}" (permit-overrides).` }
      }
      return { decision: "deny", decidingPolicy: denies[0], matched, reason: `Denied by "${denies[0].name}" (permit-overrides).` }
    }
    case "priority": {
      // matched is already priority-desc; the top entry decides. Ties (equal
      // priority) break deny-over-permit for safety.
      const top = matched[0]
      const topPriority = top.priority
      const tied = matched.filter((p) => p.priority === topPriority)
      const tieDeny = tied.find((p) => p.effect === "deny")
      const decider = tieDeny ?? tied[0]
      return {
        decision: decider.effect,
        decidingPolicy: decider,
        matched,
        reason: `${decider.effect === "deny" ? "Denied" : "Permitted"} by "${decider.name}" (priority ${decider.priority}).`,
      }
    }
    case "first-applicable": {
      const first = matched[0]
      return {
        decision: first.effect,
        decidingPolicy: first,
        matched,
        reason: `${first.effect === "deny" ? "Denied" : "Permitted"} by first applicable policy "${first.name}".`,
      }
    }
    case "deny-overrides":
    default: {
      if (denies.length > 0) {
        return { decision: "deny", decidingPolicy: denies[0], matched, reason: `Denied by "${denies[0].name}" (deny-overrides).` }
      }
      return { decision: "permit", decidingPolicy: permits[0], matched, reason: `Permitted by "${permits[0].name}" (deny-overrides).` }
    }
  }
}

/**
 * Collapse an engine result to a concrete boolean using a default decision for
 * the `not_applicable` case. ABAC is used as an additive RESTRICTION layer on
 * top of RBAC, so the safe default is `permit` (no policy → ABAC does not
 * block, RBAC still governs). Pass `deny` for a default-deny posture.
 */
export function resolveDecision(result: AbacEvaluationResult, whenNotApplicable: "permit" | "deny" = "permit"): boolean {
  if (result.decision === "permit") return true
  if (result.decision === "deny") return false
  return whenNotApplicable === "permit"
}

/**
 * Convenience used by the enforcement layer: does ABAC BLOCK this access?
 * Returns true only when a deny is the resolved decision. With no matching
 * policy it returns false (does not block), preserving RBAC-only behaviour when
 * no ABAC policies exist.
 */
export function abacBlocks(
  policies: AbacPolicy[],
  req: AbacRequest,
  ctx: AbacEvalContext,
  algorithm: AbacCombiningAlgorithm = "deny-overrides",
): { blocked: boolean; result: AbacEvaluationResult } {
  const result = evaluatePolicies(policies, req, ctx, algorithm)
  return { blocked: result.decision === "deny", result }
}

// -------------------------------------------------------------------------
// Validation helpers (shared by the store + API so bad policies never persist).
// -------------------------------------------------------------------------

export function isAbacOperator(v: unknown): v is AbacOperator {
  return typeof v === "string" && (ABAC_OPERATORS as readonly string[]).includes(v)
}

export function isAbacTarget(v: unknown): v is AbacTarget {
  return v === "subject" || v === "resource" || v === "environment"
}

export function isAbacEffect(v: unknown): v is AbacEffect {
  return v === "permit" || v === "deny"
}

export function isCombiningAlgorithm(v: unknown): v is AbacCombiningAlgorithm {
  return v === "deny-overrides" || v === "permit-overrides" || v === "priority" || v === "first-applicable"
}

/** Coerce/validate a single condition from untrusted input; null when invalid. */
export function sanitizeCondition(input: any): AbacCondition | null {
  if (!input || typeof input !== "object") return null
  if (!isAbacTarget(input.target)) return null
  if (typeof input.attribute !== "string" || !input.attribute) return null
  if (!isAbacOperator(input.operator)) return null
  const opIn = input.operand
  if (!opIn || typeof opIn !== "object") return null
  let operand: AbacOperand
  if (opIn.kind === "attribute") {
    if (!isAbacTarget(opIn.target) || typeof opIn.attribute !== "string" || !opIn.attribute) return null
    operand = { kind: "attribute", target: opIn.target, attribute: opIn.attribute }
  } else {
    const v = opIn.value
    const okScalar = ["string", "number", "boolean"].includes(typeof v)
    const okArray = Array.isArray(v) && v.every((x) => ["string", "number", "boolean"].includes(typeof x))
    if (!okScalar && !okArray) return null
    operand = { kind: "literal", value: v }
  }
  return { target: input.target, attribute: input.attribute, operator: input.operator, operand }
}

export type AbacPolicyInput = {
  name: string
  description?: string | null
  effect: AbacEffect
  priority?: number
  enabled?: boolean
  modules?: string[]
  actions?: string[]
  combine?: "all" | "any"
  conditions?: any[]
}

/** Validate + normalize a policy body from the API. Returns null when invalid. */
export function sanitizePolicyInput(input: any): Omit<AbacPolicy, "id"> | null {
  if (!input || typeof input !== "object") return null
  const name = typeof input.name === "string" ? input.name.trim() : ""
  if (!name || name.length > 160) return null
  if (!isAbacEffect(input.effect)) return null
  const conditionsRaw = Array.isArray(input.conditions) ? input.conditions : []
  const conditions: AbacCondition[] = []
  for (const c of conditionsRaw) {
    const sc = sanitizeCondition(c)
    if (!sc) return null // reject the whole policy on any bad condition
    conditions.push(sc)
  }
  const modules = Array.isArray(input.modules) ? input.modules.filter((m: any) => typeof m === "string" && m).slice(0, 200) : ["*"]
  const actions = Array.isArray(input.actions) ? input.actions.filter((a: any) => typeof a === "string" && a).slice(0, 50) : ["*"]
  const priority = Number.isFinite(input.priority) ? Math.trunc(input.priority) : 0
  return {
    name,
    description: typeof input.description === "string" ? input.description.trim() || null : null,
    effect: input.effect,
    priority,
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    modules: modules.length ? modules : ["*"],
    actions: actions.length ? actions : ["*"],
    combine: input.combine === "any" ? "any" : "all",
    conditions,
  }
}
