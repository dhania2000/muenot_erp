// =============================================================
// SPEC 63 — Conditional access policy engine (pure, testable core)
// -------------------------------------------------------------
// Tenant admins define policies in the builder (components/security/
// access-policy-builder.tsx). Each policy is a set of conditions combined with
// AND/OR that, when they match the sign-in context, apply an effect: allow,
// deny, require MFA, or require re-authentication. This module is the pure
// decision engine — no DB or server-only imports — so it can be unit-tested
// directly and reused by both the server-side login enforcement path
// (lib/access-policy-store.ts -> app/api/auth/login) and the client preview.
//
// Evaluation model:
//   * Only ENABLED policies are considered.
//   * Policies are evaluated in ascending `priority` (lower = evaluated first).
//   * The first matching policy whose effect is Allow or Deny is decisive for
//     the allow/deny axis; if none match, the default is Allow.
//   * "Require MFA" and "Require re-authentication" are obligations collected
//     from every matching policy, independent of the allow/deny decision.
//   * A condition that references data unavailable at evaluation time (e.g.
//     session age or module/resource at sign-in) never matches — a safe
//     default that avoids denying on data we cannot evaluate.
// =============================================================

import { ipMatchesCidr } from "@/lib/ip-utils"

export const POLICY_FIELDS = [
  "User",
  "Role",
  "Module",
  "Resource",
  "IP condition",
  "Country",
  "Device trust",
  "MFA state",
  "Session age",
  "Time window",
] as const
export type PolicyField = (typeof POLICY_FIELDS)[number]

export const POLICY_OPERATORS = ["=", "!=", "in", "not in", "contains"] as const
export type PolicyOperator = (typeof POLICY_OPERATORS)[number]

export const POLICY_EFFECTS = ["Allow", "Deny", "Require MFA", "Require re-authentication"] as const
export type PolicyEffect = (typeof POLICY_EFFECTS)[number]

export const POLICY_SCOPES = ["Platform", "Tenant", "Module", "Resource"] as const
export type PolicyScope = (typeof POLICY_SCOPES)[number]

export type PolicyCondition = {
  id: string
  field: string
  operator: string
  value: string
}

export type AccessPolicy = {
  id: string
  name: string
  priority: number
  scope: string
  conditions: PolicyCondition[]
  combinator: "AND" | "OR"
  effect: PolicyEffect
  enabled: boolean
}

/** Everything the engine can reason about for a single sign-in / request. */
export type PolicyContext = {
  userId?: number | null
  email?: string | null
  /** Tenant role string, e.g. "tenant_admin" | "employee". */
  tenantRole?: string | null
  ip?: string | null
  /** ISO country code (e.g. "US"), when available from the edge. */
  country?: string | null
  mfaEnabled?: boolean | null
  /**
   * Whether the device is recognised from prior sign-ins. `null`/undefined
   * means "unknown / not determined" — device conditions then never match.
   */
  deviceTrusted?: boolean | null
  /** Minutes since the user last fully authenticated. Undefined at fresh sign-in. */
  sessionAgeMinutes?: number | null
}

export type PolicyDecision = {
  denied: boolean
  deniedByPolicy: string | null
  requireMfa: boolean
  requireReauth: boolean
  matched: { id: string; name: string; effect: PolicyEffect }[]
}

function norm(v: string): string {
  return v.trim().toLowerCase()
}

function toList(value: string): string[] {
  return value
    .split(",")
    .map((s) => norm(s))
    .filter(Boolean)
}

/** Generic string comparison honouring the operator. */
function compareString(actual: string | null | undefined, operator: string, value: string): boolean {
  if (actual == null) return false
  const a = norm(actual)
  switch (operator) {
    case "=":
      return a === norm(value)
    case "!=":
      return a !== norm(value)
    case "in":
      return toList(value).includes(a)
    case "not in":
      return !toList(value).includes(a)
    case "contains":
      return a.includes(norm(value))
    default:
      return false
  }
}

/** IP comparison — value(s) are CIDRs (comma-separated for in / not in). */
function compareIp(ip: string | null | undefined, operator: string, value: string): boolean {
  if (!ip) return false
  const cidrs = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const anyMatch = cidrs.some((c) => ipMatchesCidr(ip, c))
  switch (operator) {
    case "=":
    case "in":
    case "contains":
      return anyMatch
    case "!=":
    case "not in":
      return !anyMatch
    default:
      return false
  }
}

/** Parses "HH:MM" into minutes-since-midnight, or null. */
function parseClock(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Time window match, e.g. value "09:00-17:00" (local time of `now`). Supports overnight windows. */
function compareTimeWindow(now: Date, operator: string, value: string): boolean {
  const [fromStr, toStr] = value.split("-")
  if (!fromStr || !toStr) return false
  const from = parseClock(fromStr)
  const to = parseClock(toStr)
  if (from == null || to == null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  const inside = from <= to ? cur >= from && cur < to : cur >= from || cur < to
  return operator === "!=" || operator === "not in" ? !inside : inside
}

/** Evaluate a single condition against the context. */
export function evaluateCondition(cond: PolicyCondition, ctx: PolicyContext, now: Date): boolean {
  const { field, operator, value } = cond
  switch (field) {
    case "User":
      // Match against email or numeric user id.
      return (
        compareString(ctx.email ?? null, operator, value) ||
        compareString(ctx.userId != null ? String(ctx.userId) : null, operator, value)
      )
    case "Role":
      return compareString(ctx.tenantRole ?? null, operator, value)
    case "IP condition":
      return compareIp(ctx.ip, operator, value)
    case "Country":
      return compareString(ctx.country ?? null, operator, value)
    case "Device trust": {
      if (ctx.deviceTrusted == null) return false
      const actual = ctx.deviceTrusted ? "trusted" : "unknown"
      return compareString(actual, operator, value)
    }
    case "MFA state": {
      if (ctx.mfaEnabled == null) return false
      const actual = ctx.mfaEnabled ? "enabled" : "disabled"
      return compareString(actual, operator, value)
    }
    case "Session age": {
      if (ctx.sessionAgeMinutes == null) return false
      const threshold = Number(value)
      if (!Number.isFinite(threshold)) return false
      switch (operator) {
        case "=":
          return ctx.sessionAgeMinutes === threshold
        case "!=":
          return ctx.sessionAgeMinutes !== threshold
        default:
          // Treat other operators as "greater than" the threshold (stale session).
          return ctx.sessionAgeMinutes > threshold
      }
    }
    case "Time window":
      return compareTimeWindow(now, operator, value)
    // Module / Resource are request-scoped, not knowable at sign-in.
    default:
      return false
  }
}

/** Whether a whole policy matches, combining its conditions with AND/OR. */
export function policyMatches(policy: AccessPolicy, ctx: PolicyContext, now: Date): boolean {
  const active = policy.conditions.filter((c) => c.value.trim() !== "")
  if (active.length === 0) return false
  const results = active.map((c) => evaluateCondition(c, ctx, now))
  return policy.combinator === "OR" ? results.some(Boolean) : results.every(Boolean)
}

/**
 * Evaluate all policies for a sign-in context and return the combined decision.
 * `now` is injectable for deterministic testing.
 */
export function evaluateAccessPolicies(
  policies: AccessPolicy[],
  ctx: PolicyContext,
  now: Date = new Date(),
): PolicyDecision {
  const decision: PolicyDecision = {
    denied: false,
    deniedByPolicy: null,
    requireMfa: false,
    requireReauth: false,
    matched: [],
  }

  const enabled = policies.filter((p) => p.enabled).sort((a, b) => a.priority - b.priority)
  let decided = false // whether the allow/deny axis has been settled

  for (const policy of enabled) {
    if (!policyMatches(policy, ctx, now)) continue
    decision.matched.push({ id: policy.id, name: policy.name, effect: policy.effect })

    switch (policy.effect) {
      case "Deny":
        if (!decided) {
          decision.denied = true
          decision.deniedByPolicy = policy.name
          decided = true
        }
        break
      case "Allow":
        if (!decided) decided = true
        break
      case "Require MFA":
        decision.requireMfa = true
        break
      case "Require re-authentication":
        decision.requireReauth = true
        break
    }
  }

  return decision
}
