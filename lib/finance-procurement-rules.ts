import { num, round2 } from "@/lib/finance-calc"

/**
 * SPEC 136 — Procurement workflow *rules*: the pure, side-effect-free control
 * decisions that guard the requisition → RFQ → PO → goods-receipt → bill →
 * payment chain. Kept database-free (like finance-procurement-calc.ts) so the
 * exact same logic runs in the server guards and under Vitest with no MySQL.
 *
 * Every evaluator returns `null` when the action is allowed, or a human
 * message when it must be rejected — the shape the config-driven CRUD engine's
 * ASYNC_GUARDS expect.
 */

const APPROVED = "Approved"
const REJECTED = "Rejected"
const CANCELLED = "Cancelled"

function norm(v: unknown): string {
  return String(v ?? "").trim()
}

// ---------------------------------------------------------------------------
// 1. Segregation of duties — the person approving a document must not be the
//    person who created it. Only enforced on the transition INTO "Approved".
// ---------------------------------------------------------------------------

export type SodInput = {
  actorUserId: number | null | undefined
  creatorUserId: number | null | undefined
  prevStatus: string | null | undefined
  nextStatus: string | null | undefined
  documentLabel?: string
}

export function evaluateSodApproval(input: SodInput): string | null {
  const next = norm(input.nextStatus)
  const prev = norm(input.prevStatus)
  // Only a fresh approval is gated. Re-saving an already-approved row, or any
  // non-approval edit, is not a segregation-of-duties event.
  if (next !== APPROVED || prev === APPROVED) return null
  const actor = input.actorUserId
  const creator = input.creatorUserId
  if (actor != null && creator != null && Number(actor) === Number(creator)) {
    const label = input.documentLabel || "document"
    return `Segregation of duties: the ${label} creator cannot approve their own ${label}. A different user must approve it.`
  }
  return null
}

// ---------------------------------------------------------------------------
// 2. Budget limit — an approved commitment cannot exceed the remaining budget.
//    `committedAmount` is the value already committed by *other* approved
//    procurement documents against the same budget (current row excluded).
// ---------------------------------------------------------------------------

export type BudgetInput = {
  amount: unknown
  budgetedAmount: unknown
  actualAmount?: unknown
  committedAmount?: unknown
  /** When false (no matching budget on file), the check is skipped. */
  budgetFound: boolean
}

export type BudgetDecision = {
  ok: boolean
  available: number
  requested: number
  message: string | null
}

export function evaluateBudget(input: BudgetInput): BudgetDecision {
  const requested = round2(Math.max(0, num(input.amount)))
  if (!input.budgetFound) {
    return { ok: true, available: Number.POSITIVE_INFINITY, requested, message: null }
  }
  const budgeted = Math.max(0, num(input.budgetedAmount))
  const actual = Math.max(0, num(input.actualAmount))
  const committed = Math.max(0, num(input.committedAmount))
  const available = round2(Math.max(0, budgeted - actual - committed))
  if (requested > available + 1e-9) {
    return {
      ok: false,
      available,
      requested,
      message: `Budget limit exceeded: this approval needs ${requested.toFixed(
        2,
      )} but only ${available.toFixed(2)} of the referenced budget remains.`,
    }
  }
  return { ok: true, available, requested, message: null }
}

// ---------------------------------------------------------------------------
// 3. PO chain linking — a PO that cites an upstream document may only be
//    raised once that document has cleared its own gate.
// ---------------------------------------------------------------------------

export type PoChainInput = {
  requisitionRef?: string | null
  /** The referenced requisition, or null when the ref does not resolve. */
  requisition: { approval_status?: string | null } | null
  rfqRef?: string | null
  /** The referenced RFQ, or null when the ref does not resolve. */
  rfq: { status?: string | null } | null
}

export function evaluatePoChain(input: PoChainInput): string | null {
  const reqRef = norm(input.requisitionRef)
  if (reqRef) {
    if (!input.requisition) {
      return `Purchase order references requisition ${reqRef}, which does not exist.`
    }
    if (norm(input.requisition.approval_status) !== APPROVED) {
      return `Purchase order cannot be raised: requisition ${reqRef} is not approved (currently ${
        norm(input.requisition.approval_status) || "Draft"
      }).`
    }
  }
  const rfqRef = norm(input.rfqRef)
  if (rfqRef) {
    if (!input.rfq) {
      return `Purchase order references RFQ ${rfqRef}, which does not exist.`
    }
    if (norm(input.rfq.status) !== "Awarded") {
      return `Purchase order cannot be raised: RFQ ${rfqRef} has not been awarded (currently ${
        norm(input.rfq.status) || "Draft"
      }).`
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 4. Goods receipt against a PO — the PO must exist and be approved & live.
// ---------------------------------------------------------------------------

export type GrnChainInput = {
  poRef?: string | null
  po: { approval_status?: string | null; status?: string | null } | null
  receivedQuantity: unknown
}

export function evaluateGrnChain(input: GrnChainInput): string | null {
  const poRef = norm(input.poRef)
  if (!poRef) return "A goods receipt must reference a purchase order."
  if (!input.po) return `Goods receipt references purchase order ${poRef}, which does not exist.`
  if (norm(input.po.approval_status) !== APPROVED) {
    return `Goods receipt cannot be posted: purchase order ${poRef} is not approved.`
  }
  if (norm(input.po.status) === CANCELLED) {
    return `Goods receipt cannot be posted against cancelled purchase order ${poRef}.`
  }
  if (num(input.receivedQuantity) <= 0) {
    return "Received quantity must be greater than zero."
  }
  return null
}

/**
 * Derive the PO fulfilment status from the ordered quantity and the cumulative
 * quantity received across every goods receipt (including the one just saved).
 * Over-receipt still counts as Received — it is flagged on the receipt itself.
 */
export function derivePoFulfilmentStatus(
  orderedQuantity: unknown,
  totalReceived: unknown,
  currentStatus: string | null | undefined,
): string {
  const ordered = Math.max(0, num(orderedQuantity))
  const received = Math.max(0, num(totalReceived))
  const cur = norm(currentStatus)
  if (cur === CANCELLED) return CANCELLED // never resurrect a cancelled PO
  if (received <= 0) return cur || "Approved"
  if (ordered > 0 && received >= ordered) return "Received"
  return "Partially Received"
}

// ---------------------------------------------------------------------------
// 5. RFQ award — an RFQ can only be marked Awarded with at least one quote.
// ---------------------------------------------------------------------------

export function evaluateRfqAward(nextStatus: unknown, quoteCount: unknown): string | null {
  if (norm(nextStatus) === "Awarded" && num(quoteCount) <= 0) {
    return "An RFQ cannot be awarded before at least one vendor quote is captured."
  }
  return null
}

// ---------------------------------------------------------------------------
// 6. Cancellation rules — a document cannot be cancelled once the chain has
//    moved downstream of it.
// ---------------------------------------------------------------------------

export function evaluateRequisitionCancellation(
  nextStatus: unknown,
  opts: { linkedPoCount: number },
): string | null {
  if (norm(nextStatus) === CANCELLED && opts.linkedPoCount > 0) {
    return `Requisition cannot be cancelled: ${opts.linkedPoCount} purchase order(s) already reference it. Cancel the purchase order(s) first.`
  }
  return null
}

export function evaluatePoCancellation(
  nextStatus: unknown,
  opts: { grnCount: number; billCount: number },
): string | null {
  if (norm(nextStatus) !== CANCELLED) return null
  if (opts.grnCount > 0) {
    return `Purchase order cannot be cancelled: ${opts.grnCount} goods receipt(s) already exist against it.`
  }
  if (opts.billCount > 0) {
    return `Purchase order cannot be cancelled: ${opts.billCount} vendor bill(s) already reference it.`
  }
  return null
}

export const PROCUREMENT_STATUS = { APPROVED, REJECTED, CANCELLED } as const
