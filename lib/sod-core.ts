// =============================================================================
// SPEC 13 — Segregation of Duties: pure policy engine (Phase 2).
// -----------------------------------------------------------------------------
// DB-free and framework-free. Given the set of duty keys a user HOLDS and the
// resolved (per-tenant) conflict matrix, decide which conflicts are violated
// and whether any violation must BLOCK the operation. Kept pure so the policy
// can be exercised exhaustively in unit tests (see test/sod.test.ts). The DB /
// orchestration layer that computes the held-duty set and persists results is
// lib/sod.ts.
// =============================================================================

import type { ActionCategory, ModulePermission, PermissionAction } from "./permission-model"
import type { SodEnforcement, SodSeverity } from "./sod-registry"

/** A conflict after per-tenant overrides have been applied. */
export type ResolvedConflict = {
  key: string
  label: string
  description: string
  dutyA: string
  dutyB: string
  severity: SodSeverity
  enforcement: SodEnforcement
  enabled: boolean
  custom: boolean
}

/** A detected co-holding of two incompatible duties. */
export type SodViolation = {
  conflictKey: string
  conflictLabel: string
  dutyA: string
  dutyB: string
  severity: SodSeverity
  enforcement: SodEnforcement
}

/**
 * The base CRUD verb a normalized capability category maps onto. Only the four
 * base verbs have a direct column; other categories (approve/export/…) live in
 * a module's extended actions and are resolved by the store layer.
 */
const CATEGORY_BASE: Partial<Record<ActionCategory, PermissionAction>> = {
  create: "add",
  edit: "update",
  view: "view",
  delete: "delete",
}

/**
 * Whether a module permission grants a capability category through its base
 * CRUD scope (non-"none"). Pure: extended-action categories are handled by the
 * caller since classifying them needs the module's action definitions.
 */
export function baseCategoryGranted(
  perm: ModulePermission | null | undefined,
  category: ActionCategory,
): boolean {
  if (!perm) return false
  const base = CATEGORY_BASE[category]
  if (!base) return false
  const scope = perm[base]
  return Boolean(scope) && scope !== "none"
}

/**
 * Evaluate the resolved conflict matrix against a user's held duties. A
 * conflict is violated only when it is ENABLED and BOTH of its duties are held.
 */
export function evaluateConflicts(held: ReadonlySet<string>, conflicts: ResolvedConflict[]): SodViolation[] {
  const out: SodViolation[] = []
  for (const c of conflicts) {
    if (!c.enabled) continue
    if (held.has(c.dutyA) && held.has(c.dutyB)) {
      out.push({
        conflictKey: c.key,
        conflictLabel: c.label,
        dutyA: c.dutyA,
        dutyB: c.dutyB,
        severity: c.severity,
        enforcement: c.enforcement,
      })
    }
  }
  return out
}

/** True when any violation is set to block (not merely warn). */
export function hasBlockingViolation(violations: readonly SodViolation[]): boolean {
  return violations.some((v) => v.enforcement === "block")
}

const SEVERITY_RANK: Record<SodSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 }

/** The highest severity among a set of violations, or null when there are none. */
export function peakSeverity(violations: readonly SodViolation[]): SodSeverity | null {
  let best: SodSeverity | null = null
  for (const v of violations) {
    if (best === null || SEVERITY_RANK[v.severity] > SEVERITY_RANK[best]) best = v.severity
  }
  return best
}
