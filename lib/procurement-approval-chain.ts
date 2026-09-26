import "server-only"
import { getSession } from "@/lib/auth"
import { num } from "@/lib/finance-calc"
import { getEntityApprovalStatus, raiseApprovalRequest } from "@/lib/approval-authority"

/**
 * Spec36 (#200) — bridge between the four procurement documents and the shared
 * Approval Authority engine (lib/approval-authority.ts). This is deliberately a
 * thin adapter, NOT a second approvals subsystem: requisitions and purchase
 * orders raise a configurable, multi-level approval request when they are
 * submitted, and cannot be marked "Approved" until that request has cleared.
 *
 * RFQs (awarded, not approved) and goods receipts (no approval_status) have no
 * approval chain and are intentional no-ops here.
 *
 * Both functions run inside lib/finance-crud.ts, which has already resolved and
 * bounded the acting tenant; the approval engine derives the same tenant from
 * the verified session (never client input).
 */

type ApprovalModule = {
  /** Matches the entity_type used by finance-procurement's audit + requests. */
  entityType: string
  refColumn: string
  amountColumn: string
  departmentColumn?: string
  label: string
  title: (row: Record<string, any>) => string
}

const APPROVAL_MODULES: Record<string, ApprovalModule> = {
  "purchase-requisition": {
    entityType: "procurement_requisition",
    refColumn: "requisition_id",
    amountColumn: "estimated_amount",
    departmentColumn: "department",
    label: "requisition",
    title: (r) => `Requisition ${s(r.requisition_id)}`,
  },
  "purchase-orders": {
    entityType: "procurement_po",
    refColumn: "po_number",
    amountColumn: "total_amount",
    departmentColumn: "department",
    label: "purchase order",
    title: (r) => `Purchase order ${s(r.po_number)} — ${s(r.vendor_name) || "vendor"}`,
  },
}

function s(v: unknown): string {
  return String(v ?? "").trim()
}

/**
 * When a requisition / purchase order enters "Submitted", raise (exactly once)
 * an approval request against the configured authority chain for the tenant.
 *
 *  - A fresh submit with no live request → a new request is raised. When no
 *    rule matches the engine auto-approves it, so single-approver tenants keep
 *    working with just the maker/checker SoD guard.
 *  - An already pending / approved request for the same document is left alone,
 *    so an idempotent replay or an idle re-save never fans out duplicates.
 *  - A resubmission after a rejected / cancelled cycle (prev status is not
 *    "Submitted") raises a fresh request.
 */
export async function raiseProcurementApproval(
  moduleKey: string,
  finalRow: Record<string, any>,
  existing: Record<string, any> | null,
  userId: number,
): Promise<void> {
  const mod = APPROVAL_MODULES[moduleKey]
  if (!mod || finalRow?.id == null) return

  const nextStatus = s(finalRow.approval_status)
  const prevStatus = s(existing?.approval_status)
  if (nextStatus !== "Submitted" || prevStatus === "Submitted") return

  const entityPk = Number(finalRow.id)
  const current = await getEntityApprovalStatus(mod.entityType, entityPk)
  if (current && (current.status === "pending" || current.status === "approved")) return

  const session = await getSession()
  await raiseApprovalRequest({
    moduleKey,
    entityType: mod.entityType,
    entityPk,
    entityRef: s(finalRow[mod.refColumn]) || null,
    title: mod.title(finalRow),
    amount: num(finalRow[mod.amountColumn]),
    department: mod.departmentColumn ? s(finalRow[mod.departmentColumn]) || null : null,
    requestedBy: userId,
    requestedByName: session?.name ?? null,
  })
}

/**
 * Block a requisition / purchase order from reaching "Approved" until its
 * Approval Authority chain has cleared. Returns an error string (→ HTTP 409)
 * when the chain is still pending or was rejected; returns null when there is
 * nothing to hold the document up:
 *
 *  - request approved            → allow (the chain signed off)
 *  - request auto-approved       → allow (no rule matched; engine returns
 *                                  "approved" with no steps)
 *  - request cancelled / none    → allow; the maker/checker SoD guard in
 *                                  finance-procurement still applies
 *
 * The maker/checker segregation-of-duties rule lives in the approval engine and
 * in the per-document guards, so this only adds the multi-level gate.
 */
export async function guardProcurementApprovalChain(
  moduleKey: string,
  existing: Record<string, any> | null,
  merged: Record<string, any>,
): Promise<string | null> {
  const mod = APPROVAL_MODULES[moduleKey]
  if (!mod || existing?.id == null) return null

  const prevStatus = s(existing.approval_status)
  const nextStatus = s(merged.approval_status)
  if (nextStatus !== "Approved" || prevStatus === "Approved") return null

  const request = await getEntityApprovalStatus(mod.entityType, Number(existing.id))
  if (!request) return null
  if (request.status === "approved" || request.status === "cancelled") return null
  if (request.status === "rejected") {
    return `This ${mod.label} cannot be approved: its approval authority chain was rejected. Resubmit it to raise a new approval request.`
  }
  const level = request.currentLevel != null ? ` (currently at level ${request.currentLevel})` : ""
  return `This ${mod.label} cannot be approved yet: its approval authority chain is still pending${level}.`
}
