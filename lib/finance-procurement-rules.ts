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

export function evaluateRfqCancellation(nextStatus: unknown, opts: { linkedPoCount: number }): string | null {
  if (norm(nextStatus) === CANCELLED && opts.linkedPoCount > 0) {
    return `RFQ cannot be cancelled: ${opts.linkedPoCount} purchase order(s) already reference it. Cancel the purchase order(s) first.`
  }
  return null
}

// ---------------------------------------------------------------------------
// 7. Approval state machine — Draft → Submitted → Approved | Rejected.
//    A new document can never be created already Approved (that would skip
//    the checker), and an Approved document cannot be walked back.
// ---------------------------------------------------------------------------

const APPROVAL_TRANSITIONS: Record<string, string[]> = {
  Draft: ["Draft", "Submitted"],
  Submitted: ["Submitted", "Approved", "Rejected", "Draft"],
  Rejected: ["Rejected", "Draft", "Submitted"],
  Approved: ["Approved"],
}

export function evaluateApprovalTransition(
  prevStatus: unknown,
  nextStatus: unknown,
  opts: { isCreate: boolean; documentLabel?: string },
): string | null {
  const label = opts.documentLabel || "document"
  const next = norm(nextStatus) || "Draft"
  if (!(next in APPROVAL_TRANSITIONS)) return `Unknown approval status "${next}".`
  if (opts.isCreate) {
    if (next === APPROVED || next === REJECTED) {
      return `A new ${label} must start as Draft or Submitted; it cannot be created already ${next}.`
    }
    return null
  }
  const prev = norm(prevStatus) || "Draft"
  const allowed = APPROVAL_TRANSITIONS[prev] ?? APPROVAL_TRANSITIONS.Draft
  if (!allowed.includes(next)) {
    return `Invalid approval transition for this ${label}: ${prev} → ${next}.`
  }
  return null
}

/**
 * Once a document is Approved its commercial fields are frozen — changing the
 * amount after the checker signed off would bypass the approval and budget
 * control. Returns the first changed locked field as a rejection message.
 */
export function evaluateApprovedImmutability(
  existing: Record<string, any> | null,
  body: Record<string, any>,
  lockedFields: readonly string[],
  documentLabel = "document",
): string | null {
  if (!existing || norm(existing.approval_status) !== APPROVED) return null
  for (const field of lockedFields) {
    if (!(field in body)) continue
    const before = existing[field]
    const after = body[field]
    const numeric = typeof before === "number" || /^-?\d+(\.\d+)?$/.test(norm(before))
    const changed = numeric ? round2(num(before)) !== round2(num(after)) : norm(before) !== norm(after)
    if (changed) {
      return `This ${documentLabel} is approved; "${field}" can no longer be changed. Cancel it and raise a new one instead.`
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 8. Upstream consistency — the PO must honour what was approved / awarded.
// ---------------------------------------------------------------------------

export type PoUpstreamInput = {
  poQuantity: unknown
  poTaxable: unknown
  poVendorId?: unknown
  poVendorName?: unknown
  requisition?: { quantity?: unknown } | null
  rfq?: { selected_vendor_id?: unknown; selected_vendor_name?: unknown; awarded_amount?: unknown } | null
  /** Quantity already ordered on OTHER live POs against the same requisition. */
  otherOrderedQuantity?: unknown
}

export function evaluatePoAgainstUpstream(input: PoUpstreamInput): string | null {
  const qty = num(input.poQuantity)
  if (qty <= 0) return "Purchase order quantity must be greater than zero."
  if (input.requisition) {
    const reqQty = num(input.requisition.quantity)
    const already = Math.max(0, num(input.otherOrderedQuantity))
    if (reqQty > 0 && qty + already > reqQty + 1e-9) {
      return `Purchase order quantity ${qty} exceeds the requisition's remaining quantity ${round2(
        Math.max(0, reqQty - already),
      )}.`
    }
  }
  if (input.rfq) {
    const awardedId = norm(input.rfq.selected_vendor_id)
    const awardedName = norm(input.rfq.selected_vendor_name).toLowerCase()
    const poId = norm(input.poVendorId)
    const poName = norm(input.poVendorName).toLowerCase()
    const vendorMatches = (awardedId && poId && awardedId === poId) || (awardedName && poName && awardedName === poName)
    if ((awardedId || awardedName) && !vendorMatches) {
      return `Purchase order vendor must be the RFQ's awarded vendor (${norm(input.rfq.selected_vendor_name) || awardedId}).`
    }
    const awarded = num(input.rfq.awarded_amount)
    if (awarded > 0 && round2(num(input.poTaxable)) > round2(awarded) + 0.005) {
      return `Purchase order value before tax (${round2(num(input.poTaxable)).toFixed(
        2,
      )}) exceeds the awarded quote (${round2(awarded).toFixed(2)}).`
    }
  }
  return null
}

/** The awarded vendor must be one of the vendors that actually quoted. */
export function evaluateRfqSelection(merged: Record<string, any>): string | null {
  if (norm(merged.status) !== "Awarded") return null
  const selectedId = norm(merged.selected_vendor_id)
  const selectedName = norm(merged.selected_vendor_name).toLowerCase()
  if (!selectedId && !selectedName) return "Select the awarded vendor before marking the RFQ Awarded."
  for (const i of [1, 2, 3]) {
    const quote = num(merged[`vendor_${i}_quote`])
    if (quote <= 0) continue
    const id = norm(merged[`vendor_${i}_id`])
    const name = norm(merged[`vendor_${i}_name`]).toLowerCase()
    if ((selectedId && id === selectedId) || (selectedName && name === selectedName)) return null
  }
  return "The awarded vendor must be one of the vendors that submitted a quote."
}

// ---------------------------------------------------------------------------
// 9. Goods receipt quantities + segregation of duties.
// ---------------------------------------------------------------------------

export type GrnQuantityInput = {
  orderedQuantity: unknown
  /** Received on OTHER receipts for the same PO (current receipt excluded). */
  alreadyReceived: unknown
  receivedQuantity: unknown
  acceptedQuantity: unknown
  rejectedQuantity: unknown
  /** Tolerance for over-receipt, in percent of the ordered quantity. */
  overReceiptTolerancePercent?: number
}

export function evaluateGrnQuantities(input: GrnQuantityInput): string | null {
  const received = num(input.receivedQuantity)
  const accepted = num(input.acceptedQuantity)
  const rejected = num(input.rejectedQuantity)
  if (received < 0 || accepted < 0 || rejected < 0) return "Receipt quantities cannot be negative."
  if (accepted + rejected > received + 1e-9) {
    return `Accepted (${accepted}) plus rejected (${rejected}) cannot exceed the received quantity (${received}).`
  }
  const ordered = num(input.orderedQuantity)
  const already = Math.max(0, num(input.alreadyReceived))
  const tolerance = Math.max(0, input.overReceiptTolerancePercent ?? 0)
  const ceiling = ordered * (1 + tolerance / 100)
  if (ordered > 0 && already + received > ceiling + 1e-9) {
    return `Receipt exceeds the purchase order: ${round2(already)} already received, ${received} more would pass the ordered ${ordered}.`
  }
  return null
}

export function evaluateGrnSod(actorUserId: unknown, poApproverUserId: unknown): string | null {
  if (actorUserId == null || poApproverUserId == null || poApproverUserId === "") return null
  if (Number(actorUserId) === Number(poApproverUserId)) {
    return "Segregation of duties: the user who approved the purchase order cannot also record its goods receipt."
  }
  return null
}

// ---------------------------------------------------------------------------
// 10. Vendor invoice (purchase bill) + payment against the procurement chain.
// ---------------------------------------------------------------------------

export type BillAgainstPoInput = {
  po: {
    approval_status?: unknown
    status?: unknown
    vendor_id?: unknown
    vendor_name?: unknown
    gst_rate?: unknown
  } | null
  poRef: string
  billVendorId?: unknown
  billVendorName?: unknown
  billTaxable: unknown
  billGstRate?: unknown
  /** Accepted value across all goods receipts of the PO. */
  receivedValue: unknown
  /** Taxable value already billed on OTHER bills against the same PO. */
  otherBilledTaxable: unknown
  grnCount: number
}

export function evaluateBillAgainstPo(input: BillAgainstPoInput): string | null {
  const ref = norm(input.poRef)
  if (!input.po) return `Vendor bill references purchase order ${ref}, which does not exist.`
  if (norm(input.po.approval_status) !== APPROVED) return `Vendor bill cannot be booked: purchase order ${ref} is not approved.`
  if (norm(input.po.status) === CANCELLED) return `Vendor bill cannot be booked against cancelled purchase order ${ref}.`
  if (input.grnCount <= 0) return `Vendor bill cannot be booked: no goods have been received against purchase order ${ref} yet.`

  const poId = norm(input.po.vendor_id)
  const billId = norm(input.billVendorId)
  const poName = norm(input.po.vendor_name).toLowerCase()
  const billName = norm(input.billVendorName).toLowerCase()
  const sameVendor = (poId && billId && poId === billId) || (poName && billName && poName === billName)
  if ((poId || poName) && (billId || billName) && !sameVendor) {
    return `Vendor bill vendor does not match purchase order ${ref}'s vendor (${norm(input.po.vendor_name) || poId}).`
  }

  const poRate = num(input.po.gst_rate)
  if (input.billGstRate != null && norm(input.billGstRate) !== "" && Math.abs(num(input.billGstRate) - poRate) > 0.001) {
    return `Vendor bill GST rate ${num(input.billGstRate)}% does not match purchase order ${ref} GST rate ${poRate}%.`
  }

  const billable = round2(Math.max(0, num(input.receivedValue) - Math.max(0, num(input.otherBilledTaxable))))
  if (round2(num(input.billTaxable)) > billable + 0.005) {
    return `Vendor bill taxable value ${round2(num(input.billTaxable)).toFixed(
      2,
    )} exceeds the received-but-unbilled value ${billable.toFixed(2)} on purchase order ${ref}.`
  }
  return null
}

export function evaluateBillPayment(input: {
  amountPaid: unknown
  payable: unknown
  previousPaid: unknown
  chainError: string | null
}): string | null {
  const paid = num(input.amountPaid)
  if (paid < 0) return "Amount paid cannot be negative."
  const payable = num(input.payable)
  if (payable > 0 && round2(paid) > round2(payable) + 0.005) {
    return `Amount paid ${round2(paid).toFixed(2)} exceeds the bill's payable amount ${round2(payable).toFixed(2)}.`
  }
  if (paid > num(input.previousPaid) && input.chainError) {
    return `Payment blocked: ${input.chainError}`
  }
  return null
}

// ---------------------------------------------------------------------------
// 11. Delete — only a document nobody downstream depends on, and never an
//     approved one (cancel it instead so the audit trail survives).
// ---------------------------------------------------------------------------

export function evaluateProcurementDelete(
  row: Record<string, any>,
  opts: { downstreamCount: number; documentLabel: string },
): string | null {
  if (norm(row.approval_status) === APPROVED || norm(row.status) === "Awarded") {
    return `An approved ${opts.documentLabel} cannot be deleted. Cancel it instead so the audit trail is kept.`
  }
  if (opts.downstreamCount > 0) {
    return `This ${opts.documentLabel} cannot be deleted: ${opts.downstreamCount} downstream document(s) reference it.`
  }
  return null
}

export const PROCUREMENT_STATUS = { APPROVED, REJECTED, CANCELLED } as const
