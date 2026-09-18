// =============================================================================
// SPEC 11 — Approval Authority: pure rule-engine core.
// -----------------------------------------------------------------------------
// This module is DB-free and framework-free on purpose. Every decision the
// approval engine makes — which rule applies to a request, how a multi-level
// chain is built, whether a level (and the whole request) is approved/rejected,
// who a delegation redirects an approval to, and which pending steps are overdue
// for escalation — lives here as a set of deterministic pure functions.
//
// Keeping this logic pure means the complex approval-chain behaviour required by
// the spec (amount / department / role / entity matching, multi-level,
// sequential vs parallel, delegation, escalation) can be exercised exhaustively
// in unit tests (see test/approval-authority.test.ts) without a database.
//
// The DB persistence + orchestration layer that calls into these functions is
// lib/approval-authority.ts.
// =============================================================================

// ---------------------------------------------------------------------------
// Approver targeting
// ---------------------------------------------------------------------------

/**
 * How a level names the people who must act on it.
 *  - user       -> a specific login account (value = user id)
 *  - role       -> everyone holding a custom role (value = role id)
 *  - department -> everyone in a department (value = department name)
 *  - dynamic    -> resolved from the request at runtime (value = DynamicApprover)
 */
export type ApproverKind = "user" | "role" | "department" | "dynamic"

/** Runtime-resolved approver slots that depend on the request, not a fixed id. */
export type DynamicApprover = "requester_manager" | "department_head" | "entity_owner"

export type ApproverTarget = {
  kind: ApproverKind
  value: string
}

// ---------------------------------------------------------------------------
// Level & rule definitions (the configurable authority)
// ---------------------------------------------------------------------------

/**
 * How the approvals WITHIN a single level combine:
 *  - all    -> every resolved approver must approve (parallel, unanimous)
 *  - any    -> a single approval clears the level (parallel, first-responder)
 *  - quorum -> at least `quorum` approvals clear the level
 *
 * Levels themselves are always processed in ascending `levelNo` order
 * (sequential): level N+1 never activates until level N is approved.
 */
export type LevelMode = "all" | "any" | "quorum"

export type ApprovalLevelDef = {
  levelNo: number
  name?: string | null
  mode: LevelMode
  /** Required approvals when mode === "quorum". Ignored otherwise. */
  quorum?: number | null
  approvers: ApproverTarget[]
  /** Escalate pending steps after this many hours of inactivity (null = never). */
  escalateAfterHours?: number | null
  /** Where an overdue step escalates to (an additional approver slot). */
  escalateTo?: ApproverTarget | null
}

/**
 * The matching conditions of a rule. A `null` condition means "matches
 * anything" on that axis; a set condition must match the request context.
 */
export type ApprovalRuleConditions = {
  /** Restrict to a specific legal entity (business/company). */
  entityId?: number | null
  /** Restrict to a requester department. */
  department?: string | null
  /** Restrict to a requester role / designation. */
  role?: string | null
  /** Inclusive lower bound on the request amount. */
  minAmount?: number | null
  /** Inclusive upper bound on the request amount. */
  maxAmount?: number | null
}

export type ApprovalRuleDef = {
  id: number
  name: string
  /** Business surface this rule governs, e.g. "finance.expenses". "*" = any. */
  moduleKey: string
  active: boolean
  /** Higher wins when several rules match. Ties broken by specificity, then id. */
  priority: number
  conditions: ApprovalRuleConditions
  levels: ApprovalLevelDef[]
}

/** The facts about a single thing needing approval, matched against rules. */
export type ApprovalContext = {
  moduleKey: string
  amount?: number | null
  department?: string | null
  role?: string | null
  entityId?: number | null
}

const WILDCARD = "*"

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase()
}

// ---------------------------------------------------------------------------
// Rule matching & selection
// ---------------------------------------------------------------------------

/** True when `ctx` satisfies every condition on `rule`. */
export function ruleMatches(rule: ApprovalRuleDef, ctx: ApprovalContext): boolean {
  if (!rule.active) return false
  if (rule.moduleKey !== WILDCARD && norm(rule.moduleKey) !== norm(ctx.moduleKey)) return false

  const c = rule.conditions
  if (c.entityId != null && c.entityId !== (ctx.entityId ?? null)) return false
  if (c.department != null && norm(c.department) !== norm(ctx.department)) return false
  if (c.role != null && norm(c.role) !== norm(ctx.role)) return false

  const amount = ctx.amount ?? 0
  if (c.minAmount != null && amount < c.minAmount) return false
  if (c.maxAmount != null && amount > c.maxAmount) return false

  return true
}

/** How many conditions a rule pins down — used to prefer the most specific match. */
export function ruleSpecificity(rule: ApprovalRuleDef): number {
  const c = rule.conditions
  let n = 0
  if (c.entityId != null) n++
  if (c.department != null) n++
  if (c.role != null) n++
  if (c.minAmount != null) n++
  if (c.maxAmount != null) n++
  return n
}

/**
 * Pick the single governing rule for a request context, or null when nothing
 * matches (the caller then treats the item as auto-approved / no authority
 * required). Selection order:
 *   1. a module-specific rule beats a "*" wildcard rule
 *   2. higher priority wins
 *   3. more specific (more pinned conditions) wins
 *   4. lowest id wins (stable, deterministic)
 */
export function selectRule(rules: ApprovalRuleDef[], ctx: ApprovalContext): ApprovalRuleDef | null {
  const matches = rules.filter((r) => ruleMatches(r, ctx))
  if (matches.length === 0) return null
  matches.sort((a, b) => {
    const aWild = a.moduleKey === WILDCARD ? 0 : 1
    const bWild = b.moduleKey === WILDCARD ? 0 : 1
    if (aWild !== bWild) return bWild - aWild
    if (a.priority !== b.priority) return b.priority - a.priority
    const spec = ruleSpecificity(b) - ruleSpecificity(a)
    if (spec !== 0) return spec
    return a.id - b.id
  })
  return matches[0]
}

// ---------------------------------------------------------------------------
// Chain construction
// ---------------------------------------------------------------------------

/** A concrete approver slot on a planned chain, before persistence. */
export type PlannedStep = {
  levelNo: number
  levelName: string | null
  mode: LevelMode
  quorum: number | null
  target: ApproverTarget
}

/**
 * Expand a rule's level definitions into the flat list of approver slots that
 * make up an approval chain. Each target on a level becomes one step; a level
 * with N targets and mode "all" therefore yields N steps that must all approve,
 * while mode "any" yields N steps of which one approval suffices.
 *
 * Levels are emitted in ascending `levelNo` so downstream progression treats
 * them sequentially.
 */
export function buildChain(rule: ApprovalRuleDef): PlannedStep[] {
  const steps: PlannedStep[] = []
  const levels = [...rule.levels].sort((a, b) => a.levelNo - b.levelNo)
  for (const level of levels) {
    for (const target of level.approvers) {
      steps.push({
        levelNo: level.levelNo,
        levelName: level.name ?? null,
        mode: level.mode,
        quorum: level.mode === "quorum" ? Math.max(1, level.quorum ?? 1) : null,
        target,
      })
    }
  }
  return steps
}

// ---------------------------------------------------------------------------
// Progression / evaluation
// ---------------------------------------------------------------------------

export type StepDecision = "pending" | "approved" | "rejected" | "skipped" | "delegated"

export type RequestStepState = {
  levelNo: number
  mode: LevelMode
  quorum: number | null
  decision: StepDecision
}

export type LevelOutcome = "pending" | "approved" | "rejected"
export type RequestStatus = "pending" | "approved" | "rejected"

/** Steps that actually count toward a level decision (skipped ones do not). */
function activeSteps(steps: RequestStepState[]): RequestStepState[] {
  return steps.filter((s) => s.decision !== "skipped")
}

/**
 * Decide the outcome of one level from its steps. A single rejection fails the
 * level (and, upstream, the whole request). Otherwise the level clears once the
 * mode's approval threshold is met.
 */
export function evaluateLevel(levelSteps: RequestStepState[]): LevelOutcome {
  const steps = activeSteps(levelSteps)
  if (steps.length === 0) return "approved"
  if (steps.some((s) => s.decision === "rejected")) return "rejected"

  const approved = steps.filter((s) => s.decision === "approved").length
  const mode = steps[0].mode

  if (mode === "any") return approved >= 1 ? "approved" : "pending"
  if (mode === "quorum") {
    const need = Math.max(1, steps[0].quorum ?? 1)
    return approved >= need ? "approved" : "pending"
  }
  // "all"
  return approved >= steps.length ? "approved" : "pending"
}

/**
 * Walk the levels in order and derive the request's overall status plus the
 * level currently awaiting action. Sequential semantics: the first level that
 * is not yet approved determines the request state; a rejection anywhere fails
 * the whole request.
 */
export function evaluateRequest(steps: RequestStepState[]): {
  status: RequestStatus
  currentLevel: number | null
} {
  const levelNos = Array.from(new Set(steps.map((s) => s.levelNo))).sort((a, b) => a - b)
  for (const levelNo of levelNos) {
    const outcome = evaluateLevel(steps.filter((s) => s.levelNo === levelNo))
    if (outcome === "rejected") return { status: "rejected", currentLevel: levelNo }
    if (outcome === "pending") return { status: "pending", currentLevel: levelNo }
  }
  return { status: "approved", currentLevel: null }
}

/**
 * The set of level numbers whose steps are "active" right now — i.e. the lowest
 * not-yet-approved level. Only steps at an active level may be acted on; this
 * enforces that a level-3 approver cannot approve before levels 1 and 2 clear.
 */
export function activeLevelNo(steps: RequestStepState[]): number | null {
  return evaluateRequest(steps).currentLevel
}

// ---------------------------------------------------------------------------
// Delegation
// ---------------------------------------------------------------------------

export type Delegation = {
  fromUserId: number
  toUserId: number
  /** ISO timestamps bounding when the delegation is effective (null = open). */
  startsAt?: string | null
  endsAt?: string | null
  active: boolean
}

function delegationActiveAt(d: Delegation, nowMs: number): boolean {
  if (!d.active) return false
  if (d.startsAt && Date.parse(d.startsAt) > nowMs) return false
  if (d.endsAt && Date.parse(d.endsAt) < nowMs) return false
  return true
}

/**
 * Follow the delegation chain from `userId` to the person who should actually
 * receive the approval right now. Cycles and self-delegations are guarded so a
 * misconfigured A->B->A pair can never loop; the last user before a cycle is
 * returned.
 */
export function resolveDelegate(userId: number, delegations: Delegation[], now: Date = new Date()): number {
  const nowMs = now.getTime()
  const seen = new Set<number>([userId])
  let current = userId
  // Bound the walk to the number of delegations to avoid pathological input.
  for (let i = 0; i <= delegations.length; i++) {
    const next = delegations.find((d) => d.fromUserId === current && delegationActiveAt(d, nowMs))
    if (!next) break
    if (seen.has(next.toUserId)) break
    seen.add(next.toUserId)
    current = next.toUserId
  }
  return current
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

export type OverdueStep = {
  levelNo: number
  /** ISO time the step became active (its level started awaiting this approver). */
  activatedAt: string | null
  escalateAfterHours: number | null
  escalateTo: ApproverTarget | null
  decision: StepDecision
}

/**
 * Given the currently-active steps and the wall-clock time, return the steps
 * that have been pending longer than their level's escalation window and have a
 * configured escalation target. The orchestration layer turns each of these
 * into an additional approver slot + an audit entry.
 */
export function computeEscalations(steps: OverdueStep[], now: Date = new Date()): OverdueStep[] {
  const nowMs = now.getTime()
  return steps.filter((s) => {
    if (s.decision !== "pending") return false
    if (!s.escalateAfterHours || s.escalateAfterHours <= 0) return false
    if (!s.escalateTo) return false
    if (!s.activatedAt) return false
    const dueMs = Date.parse(s.activatedAt) + s.escalateAfterHours * 3600_000
    return nowMs >= dueMs
  })
}
