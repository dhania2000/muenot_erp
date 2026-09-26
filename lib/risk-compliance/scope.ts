import type { DataScopeContext, DataScopeKind } from "@/lib/data-scope-model"

/**
 * Spec43 — pure scope parsing + permission-scope resolution for the risk &
 * compliance dashboard. No DB / server-only imports so it is unit-testable.
 *
 * The requested aggregation scope (group / company / branch / department) is
 * NEVER trusted as-is: it is intersected with the caller's data-scope grant on
 * the `risk.compliance` domain (managed through the existing data-scope admin).
 *
 *   - no grant / "all"      → any scope
 *   - "entity"              → only companies in `assignedEntities`; a group
 *                             request is narrowed to the first assigned company
 *   - "branch"              → only branches in `assignedBranches`; group /
 *                             company requests are narrowed to the first branch
 *   - "none" / "self" / "team" → denied: the dashboard is an org-level view
 */

export type ScopeLevel = "group" | "company" | "branch" | "department"
export const SCOPE_LEVELS: readonly ScopeLevel[] = ["group", "company", "branch", "department"]

export interface RiskScope {
  level: ScopeLevel
  value?: string | null
}

export const RISK_SCOPE_DOMAIN = "risk.compliance"

export class RiskScopeError extends Error {
  constructor(
    message: string,
    public status: 400 | 403,
  ) {
    super(message)
    this.name = "RiskScopeError"
  }
}

const VALUE_RE = /^[\p{L}\p{N} .,&()'/_-]{1,150}$/u

/** Validate raw client input into a RiskScope. Throws RiskScopeError(400). */
export function parseScopeInput(levelRaw: unknown, valueRaw: unknown): RiskScope {
  const level = (levelRaw == null || levelRaw === "" ? "group" : String(levelRaw)).toLowerCase()
  if (!(SCOPE_LEVELS as readonly string[]).includes(level)) {
    throw new RiskScopeError(`Invalid scope level "${String(levelRaw).slice(0, 30)}"`, 400)
  }
  if (level === "group") return { level: "group", value: null }
  const value = valueRaw == null ? "" : String(valueRaw).trim()
  if (!value) throw new RiskScopeError(`A ${level} value is required`, 400)
  if (!VALUE_RE.test(value)) throw new RiskScopeError(`Invalid ${level} value`, 400)
  return { level: level as ScopeLevel, value }
}

export interface ResolvedScope {
  scope: RiskScope
  /** True when the caller's grant restricted what they may see. */
  restricted: boolean
  /** True when the requested scope was narrowed to an allowed one. */
  narrowed: boolean
  /** Values the caller may pick for the restricted level (for the UI). */
  allowed: { level: ScopeLevel; values: string[] } | null
}

export function resolveRiskScope(
  requested: RiskScope,
  kind: DataScopeKind | null,
  ctx: Pick<DataScopeContext, "assignedEntities" | "assignedBranches">,
): ResolvedScope {
  if (kind == null || kind === "all") {
    return { scope: requested, restricted: false, narrowed: false, allowed: null }
  }
  if (kind === "none" || kind === "self" || kind === "team") {
    throw new RiskScopeError("Your data scope does not include organization-level risk views", 403)
  }

  const level: ScopeLevel = kind === "entity" ? "company" : "branch"
  const values = (kind === "entity" ? ctx.assignedEntities : ctx.assignedBranches).map(String)
  if (!values.length) {
    throw new RiskScopeError(`No ${level === "company" ? "companies" : "branches"} are assigned to you`, 403)
  }
  const allowed = { level, values }

  // Broader-than-grant requests are narrowed to the first assigned value.
  const broader = requested.level === "group" || (level === "branch" && requested.level === "company")
  if (broader) {
    return { scope: { level, value: values[0] }, restricted: true, narrowed: true, allowed }
  }
  if (requested.level !== level) {
    // e.g. entity grant asking for a department: we cannot prove containment.
    throw new RiskScopeError(`Your data scope only allows ${level}-level views`, 403)
  }
  if (!values.includes(String(requested.value))) {
    throw new RiskScopeError(`That ${level} is outside your data scope`, 403)
  }
  return { scope: requested, restricted: true, narrowed: false, allowed }
}

export function scopeKeyOf(scope: RiskScope): string {
  if (scope.level === "group") return "group"
  return `${scope.level}:${(scope.value ?? "").toString().slice(0, 150)}`
}
