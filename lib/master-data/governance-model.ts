/**
 * SPEC 91 — Master Data Governance: pure state machine (Phase 1 & 2).
 * ---------------------------------------------------------------------------
 * This module holds ZERO database access. It encodes the governance rules that
 * make the workflow safe and testable in isolation:
 *
 *   - Which SPEC 90 masters are "critical" and therefore governed (Phase 1).
 *   - The lifecycle every governed value moves through: Draft → Pending
 *     Approval → Active → Inactive → Archived (Phase 2).
 *   - Which transitions are legal, what a change-request action resolves to,
 *     and who is allowed to approve a request (segregation of duties).
 *
 * The service (governance.ts) is the only thing that touches the database; it
 * defers every decision to the pure helpers here so the rules can be unit
 * tested without a live DB (see test/master-data-governance.test.ts).
 */
import type { MasterKind } from "./types"

/** Lifecycle states of a governed master value. */
export type GovStatus = "draft" | "pending_approval" | "active" | "inactive" | "archived"

/** The change a maker can request against a governed value. */
export type GovAction = "create" | "update" | "deactivate" | "reactivate" | "archive"

/** Review outcome an approver can record on a pending change request. */
export type GovDecision = "approved" | "rejected"

/** Status of a change request in the workflow. */
export type ChangeRequestStatus = "pending" | "approved" | "rejected" | "cancelled"

export const GOV_STATUSES: readonly GovStatus[] = [
  "draft",
  "pending_approval",
  "active",
  "inactive",
  "archived",
] as const

export const GOV_ACTIONS: readonly GovAction[] = [
  "create",
  "update",
  "deactivate",
  "reactivate",
  "archive",
] as const

/**
 * PHASE 1 — governed masters.
 * ---------------------------------------------------------------------------
 * Not every master needs formal governance. We govern the values that carry
 * financial, statutory or control weight, where an unreviewed change would
 * ripple into postings, tax, or approvals. Everything else (countries, cities,
 * units…) stays freely editable through the SPEC 90 service.
 *
 * Note: `tax_codes` is delegated to the Finance module (registry.ts), which
 * owns its own posting-grade approval. It is intentionally NOT duplicated here
 * so there is a single approval authority for tax.
 */
export const GOVERNED_KINDS: readonly MasterKind[] = [
  "currencies",
  "payment_terms",
  "approval_levels",
  "cost_centers",
] as const

const GOVERNED = new Set<MasterKind>(GOVERNED_KINDS)

/** True when a master kind is subject to the governance workflow. */
export function isGovernedKind(kind: MasterKind): boolean {
  return GOVERNED.has(kind)
}

/**
 * PHASE 2 — legal lifecycle transitions.
 * A value starts as a Draft, is submitted for Approval, becomes Active once
 * approved, can be taken Inactive (still resolvable for history) and finally
 * Archived (terminal). An Active value re-enters Pending Approval when a change
 * is submitted against it.
 */
const TRANSITIONS: Record<GovStatus, readonly GovStatus[]> = {
  draft: ["pending_approval", "archived"],
  pending_approval: ["active", "draft", "archived"],
  active: ["pending_approval", "inactive", "archived"],
  inactive: ["pending_approval", "active", "archived"],
  archived: [],
}

/** Whether `to` is a legal next status from `from`. */
export function canTransition(from: GovStatus, to: GovStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

/** The set of statuses reachable from `from`. */
export function allowedTransitions(from: GovStatus): readonly GovStatus[] {
  return TRANSITIONS[from] ?? []
}

/**
 * The status a governed value lands in once a change request of `action` is
 * APPROVED. Submitting any action first moves the record to `pending_approval`;
 * this is the post-approval resting state.
 */
export function resolvedStatusForAction(action: GovAction): GovStatus {
  switch (action) {
    case "create":
    case "update":
    case "reactivate":
      return "active"
    case "deactivate":
      return "inactive"
    case "archive":
      return "archived"
  }
}

/**
 * Validate that `action` is coherent with the value's current governance
 * status, independent of who requests it. Returns a reason when illegal so the
 * caller can surface it. A brand-new value has `current === null`.
 */
export function validateActionForStatus(
  action: GovAction,
  current: GovStatus | null,
): { ok: true } | { ok: false; reason: string } {
  if (action === "create") {
    if (current && current !== "draft") {
      return { ok: false, reason: `Cannot create: value already governed (status: ${current}).` }
    }
    return { ok: true }
  }
  if (current == null) {
    return { ok: false, reason: `Cannot ${action}: value is not under governance yet.` }
  }
  if (current === "archived") {
    return { ok: false, reason: "Value is archived and can no longer change." }
  }
  if (action === "reactivate" && current !== "inactive") {
    return { ok: false, reason: "Only an inactive value can be reactivated." }
  }
  if (action === "deactivate" && current !== "active") {
    return { ok: false, reason: "Only an active value can be deactivated." }
  }
  return { ok: true }
}

/**
 * Segregation of duties: decide whether `approver` may act on a change request
 * raised by `requester`. The maker may never approve their own request, and the
 * approver must hold approval authority (tenant admin, or an explicitly granted
 * authority matching the record).
 */
export function evaluateApprovalAuthority(opts: {
  requesterId: number
  approverId: number
  approverIsAdmin: boolean
  /** Authority codes the approver holds (optional, future-proofing). */
  approverAuthorities?: string[]
  /** Authority code the record requires, if any. */
  requiredAuthority?: string | null
}): { ok: true } | { ok: false; reason: string } {
  const { requesterId, approverId, approverIsAdmin, approverAuthorities = [], requiredAuthority } = opts
  if (approverId === requesterId) {
    return { ok: false, reason: "The maker of a change request cannot approve it (segregation of duties)." }
  }
  if (approverIsAdmin) return { ok: true }
  if (requiredAuthority && approverAuthorities.includes(requiredAuthority)) return { ok: true }
  return { ok: false, reason: "You do not hold the approval authority for this master." }
}

/**
 * Whether a change becomes effective now or is scheduled. `effectiveDate` is an
 * ISO date (YYYY-MM-DD) or null (immediate). Compared date-only so a same-day
 * effective date is active immediately regardless of time zone.
 */
export function isEffectiveNow(effectiveDate: string | null | undefined, now: Date = new Date()): boolean {
  if (!effectiveDate) return true
  const today = now.toISOString().slice(0, 10)
  return effectiveDate <= today
}

/** Human label for a status (UI + audit). */
export function statusLabel(status: GovStatus): string {
  switch (status) {
    case "draft":
      return "Draft"
    case "pending_approval":
      return "Pending Approval"
    case "active":
      return "Active"
    case "inactive":
      return "Inactive"
    case "archived":
      return "Archived"
  }
}
