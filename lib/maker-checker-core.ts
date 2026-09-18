/**
 * SPEC 12 — Maker-Checker · pure decision core.
 *
 * DB-free predicates that encode the two guarantees the framework must never
 * get wrong:
 *
 *   1. Segregation of duties — the maker of a request can never also be its
 *      checker (self-approval is forbidden, for everyone, admins included).
 *   2. Bypass prevention — a gated operation is only allowed to take effect
 *      once its approval request reached a terminal `approved` state.
 *
 * Keeping these here (separate from the orchestration in `maker-checker.ts`)
 * means the security-critical logic is exhaustively unit-testable without a
 * database, mirroring how SPEC 11 splits `approval-authority-core.ts`.
 */

/** Actions a user can take on an approval request. */
export type ApprovalActionKind = "approve" | "reject" | "delegate" | "escalate" | "cancel"

/**
 * Actions that constitute "acting as a checker" and therefore must be denied
 * to the maker. Rejecting is also a checker decision, so a maker cannot reject
 * their own request either (they cancel it instead). Cancelling is the maker's
 * own withdrawal and stays allowed.
 */
const CHECKER_ACTIONS: ReadonlySet<ApprovalActionKind> = new Set(["approve", "reject", "delegate", "escalate"])

export type SegregationInput = {
  /** The user attempting the action. */
  actorId: number
  /** The user who raised the request (the maker). */
  requesterId: number | null
  action: ApprovalActionKind
}

/**
 * Core segregation-of-duties rule. Returns true when the action would let the
 * maker act as their own checker and must be blocked.
 *
 * This deliberately takes NO "isAdmin" escape hatch: four-eyes means four eyes
 * even for administrators. An admin who raised a request must have a different
 * admin approve it.
 */
export function violatesSegregation({ actorId, requesterId, action }: SegregationInput): boolean {
  if (requesterId == null) return false
  if (!CHECKER_ACTIONS.has(action)) return false
  return actorId === requesterId
}

/** Human-readable reason used when {@link violatesSegregation} is true. */
export const SEGREGATION_MESSAGE =
  "Segregation of duties: the person who raised a request cannot approve, reject, delegate or escalate it. A different authorised checker must act on it."

/**
 * The lifecycle of a captured maker-checker change.
 *
 *   pending       → awaiting a checker's decision; NOT yet applied.
 *   auto_applied  → no approval rule matched, so it applied immediately.
 *   applied       → a checker approved and the change took effect.
 *   rejected      → a checker rejected; the change was discarded.
 *   cancelled     → the maker withdrew before a decision.
 *   failed        → approved, but applying the change threw (needs attention).
 */
export type ChangeStatus = "pending" | "auto_applied" | "applied" | "rejected" | "cancelled" | "failed"

/** A change is still "open" (money/access not yet moved, decision outstanding). */
export function isOpenStatus(status: ChangeStatus): boolean {
  return status === "pending"
}

/** A change has taken effect (either auto-applied or approved-then-applied). */
export function isEffectiveStatus(status: ChangeStatus): boolean {
  return status === "applied" || status === "auto_applied"
}

/**
 * Bypass-prevention gate. Given the terminal state of the approval request that
 * governs a captured change, decide what should happen to the change.
 *
 * The ONLY way `apply` is true is an `approved` request — there is no code path
 * that lets a `pending` or `rejected` request cause the underlying operation to
 * execute.
 */
export type OutcomeDecision = { apply: boolean; nextStatus: ChangeStatus | null }

export function decideOutcome(
  requestStatus: "pending" | "approved" | "rejected" | "cancelled",
  currentChangeStatus: ChangeStatus,
): OutcomeDecision {
  // Never re-act on a change that already reached a terminal state.
  if (!isOpenStatus(currentChangeStatus)) return { apply: false, nextStatus: null }

  switch (requestStatus) {
    case "approved":
      return { apply: true, nextStatus: "applied" }
    case "rejected":
      return { apply: false, nextStatus: "rejected" }
    case "cancelled":
      return { apply: false, nextStatus: "cancelled" }
    case "pending":
    default:
      return { apply: false, nextStatus: null }
  }
}
