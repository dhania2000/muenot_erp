import "server-only"
import { query } from "@/lib/db"
import { num, round2 } from "@/lib/finance-calc"
import { getSettings } from "@/lib/settings/server"
import { syncExpensePosting, reverseExpensePosting } from "@/lib/finance-expense-posting"
import { logFinanceEvent } from "@/lib/finance-audit"
import { assertPeriodOpen } from "@/lib/finance-period-lock"

/**
 * Expense approval workflow — the authoritative lifecycle state machine.
 *
 * The full lifecycle is:
 *
 *   Draft → Pending Approval → Approved → Posted → (Partially Paid) → Paid
 *
 * with two terminal branches: Rejected and Cancelled. `workflow_status` on the
 * expense row carries the fine-grained state; `approval_status` is kept as the
 * coarse Pending / Approved / Rejected mirror that the list UI badges read.
 *
 * This module is the ONLY place allowed to move an expense between states. It
 * enforces:
 *   - legal transitions (Phase 1);
 *   - amount-tiered approval routing (Phase 2) from configured thresholds,
 *     never hard-coded names;
 *   - segregation of duties (Phase 3) — the creator cannot approve their own
 *     expense unless SoD is switched off in settings;
 *   - accounting side effects: approving auto-posts the accrual (Phase 12/13),
 *     rejecting / cancelling reverses it, and every move is period-lock aware
 *     (Phase 42) and written to the audit trail (Phase 48).
 *
 * Money is never computed here — posting reads the stored, server-authoritative
 * totals via the central posting engine (finance-expense-posting), which itself
 * routes through the shared Journal + General Ledger (finance-posting).
 */

export type ExpenseWorkflowState =
  | "Draft"
  | "Pending Approval"
  | "Approved"
  | "Posted"
  | "Partially Paid"
  | "Paid"
  | "Rejected"
  | "Cancelled"

export type ExpenseWorkflowAction = "submit" | "approve" | "reject" | "cancel" | "reopen"

export type ApprovalTier = "standard" | "finance_manager" | "senior"

/** States that own an active accounting posting (the accrual is recognised). */
const POSTED_STATES: ExpenseWorkflowState[] = ["Posted", "Partially Paid", "Paid"]

/** Legal source states for each action (Phase 1). */
const TRANSITIONS: Record<ExpenseWorkflowAction, ExpenseWorkflowState[]> = {
  submit: ["Draft", "Rejected"],
  approve: ["Pending Approval"],
  reject: ["Pending Approval", "Approved", "Posted"],
  cancel: ["Draft", "Pending Approval", "Approved", "Posted", "Partially Paid"],
  reopen: ["Rejected", "Cancelled"],
}

/** Coarse approval_status mirror derived from the fine-grained workflow state. */
function coarseApproval(state: ExpenseWorkflowState): "Pending" | "Approved" | "Rejected" {
  if (state === "Approved" || POSTED_STATES.includes(state)) return "Approved"
  if (state === "Rejected") return "Rejected"
  return "Pending"
}

function parseIdList(value: unknown): number[] {
  return String(value ?? "")
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
}

/**
 * Amount-tiered approval routing (Phase 2). The thresholds come from company
 * settings so no employee name or amount is ever hard-coded; sensible INR
 * defaults apply when unset.
 */
export function approvalTierForAmount(amount: number, settings: Record<string, any>): ApprovalTier {
  const medium = num(settings["finance.expense.approval_threshold_medium"]) || 50000
  const high = num(settings["finance.expense.approval_threshold_high"]) || 200000
  const value = round2(amount)
  if (high > 0 && value >= high) return "senior"
  if (medium > 0 && value >= medium) return "finance_manager"
  return "standard"
}

/**
 * Is this actor authorised to approve an expense at the given tier (Phase 2)?
 * Admins always qualify. Higher tiers additionally require the actor to be in
 * the configured approver list — identified by user id, never by name.
 */
function canApproveTier(
  tier: ApprovalTier,
  actor: { id: number; role: "admin" | "employee" },
  settings: Record<string, any>,
): boolean {
  if (actor.role === "admin") return true
  if (tier === "standard") return true
  const managerIds = parseIdList(settings["finance.expense.finance_manager_ids"])
  const seniorIds = parseIdList(settings["finance.expense.senior_approver_ids"])
  if (tier === "finance_manager") return managerIds.includes(actor.id) || seniorIds.includes(actor.id)
  return seniorIds.includes(actor.id)
}

const TIER_LABEL: Record<ApprovalTier, string> = {
  standard: "standard approval",
  finance_manager: "Finance Manager",
  senior: "authorized senior approver",
}

export type TransitionResult = {
  ok: true
  expense_id: string
  from: ExpenseWorkflowState
  to: ExpenseWorkflowState
  voucher_no?: string | null
}

/**
 * Resolve an expense by its numeric primary key OR its business id (EXP-...).
 */
async function loadExpense(idOrRef: number | string): Promise<Record<string, any> | null> {
  if (typeof idOrRef === "number" || /^\d+$/.test(String(idOrRef))) {
    const [row] = (await query(`SELECT * FROM expenses WHERE id = ? LIMIT 1`, [Number(idOrRef)])) as any[]
    if (row) return row
  }
  const [byRef] = (await query(`SELECT * FROM expenses WHERE expense_id = ? LIMIT 1`, [String(idOrRef)])) as any[]
  return byRef ?? null
}

/** Current workflow state of a row, defaulting legacy rows sensibly. */
function stateOf(exp: Record<string, any>): ExpenseWorkflowState {
  const wf = String(exp.workflow_status || "").trim()
  if (wf) return wf as ExpenseWorkflowState
  // Legacy rows predate workflow_status: fall back to the coarse flag.
  const coarse = String(exp.approval_status || "").trim()
  if (coarse === "Approved") return "Approved"
  if (coarse === "Rejected") return "Rejected"
  return "Draft"
}

/** Persist a new state + its coarse mirror + timestamps, then audit it. */
async function applyState(
  exp: Record<string, any>,
  to: ExpenseWorkflowState,
  extra: Record<string, any> = {},
) {
  const set: Record<string, any> = { workflow_status: to, approval_status: coarseApproval(to), ...extra }
  const cols = Object.keys(set)
  await query(
    `UPDATE expenses SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id=?`,
    [...cols.map((c) => set[c]), exp.id],
  )
}

/**
 * Move an expense through its workflow. This is the single entry point for
 * submit / approve / reject / cancel / reopen and owns every accounting side
 * effect. Throws a descriptive Error on any illegal or unauthorised move.
 */
export async function transitionExpense(
  idOrRef: number | string,
  action: ExpenseWorkflowAction,
  opts: {
    actorId: number
    actorRole: "admin" | "employee"
    reason?: string | null
    override?: boolean
  },
): Promise<TransitionResult> {
  const exp = await loadExpense(idOrRef)
  if (!exp) throw new Error("Expense not found.")

  const from = stateOf(exp)
  const legal = TRANSITIONS[action]
  if (!legal || !legal.includes(from)) {
    throw new Error(`Cannot ${action} an expense that is "${from}".`)
  }

  const settings = await getSettings().catch(() => ({}) as Record<string, any>)
  const actor = { id: opts.actorId, role: opts.actorRole }
  const ref = String(exp.expense_id || exp.id)
  const amount = round2(num(exp.net_payable) || num(exp.gross_amount) || num(exp.taxable_amount))

  // Any state change that touches a dated posting must respect the period lock.
  await assertPeriodOpen(exp.expense_date)

  let to: ExpenseWorkflowState = from
  let voucherNo: string | null = null

  switch (action) {
    case "submit": {
      to = "Pending Approval"
      await applyState(exp, to, {
        submitted_at: new Date(),
        rejected_reason: null,
        cancelled_reason: null,
      })
      await audit(exp, ref, "submitted", `Submitted expense ${ref} for approval (${amount})`, opts.actorId)
      break
    }

    case "approve": {
      // --- Phase 3: segregation of duties -----------------------------------
      const enforceSod = String(settings["finance.expense.enforce_sod"] ?? "true") !== "false"
      if (enforceSod && !opts.override && Number(exp.created_by) === Number(opts.actorId) && actor.role !== "admin") {
        throw new Error("Segregation of duties: the creator of an expense cannot approve it.")
      }

      // --- Phase 2: amount-tiered approval authority ------------------------
      const tier = approvalTierForAmount(amount, settings)
      if (!canApproveTier(tier, actor, settings)) {
        throw new Error(`This expense (${amount}) requires ${TIER_LABEL[tier]}. You are not authorised to approve it.`)
      }

      // Recognise the approval, then auto-post the accrual (Phase 12/13). The
      // posting engine reads Approved as a postable state and stamps the
      // voucher; we then advance the state to Posted.
      await applyState(exp, "Approved", {
        approved_by_id: opts.actorId,
        approved_at: new Date(),
        rejected_reason: null,
      })
      await audit(exp, ref, "approved", `Approved expense ${ref} (${amount}) at ${TIER_LABEL[tier]} tier`, opts.actorId)

      const posting = await syncExpensePosting(ref, { createdBy: opts.actorId })
      if (posting.action === "error") {
        throw new Error("Expense approved but posting to the ledger failed. Resolve the accounting error and retry.")
      }
      voucherNo = posting.voucherNo ?? null
      // Reflect the posted accrual in the workflow state (unless payments have
      // already nudged it further — recompute owns Partially Paid / Paid).
      const [fresh] = (await query(`SELECT workflow_status FROM expenses WHERE id = ? LIMIT 1`, [exp.id])) as any[]
      if (!POSTED_STATES.includes(String(fresh?.workflow_status) as ExpenseWorkflowState)) {
        await applyState(exp, "Posted")
      }
      to = "Posted"
      if (voucherNo) {
        await audit(exp, ref, "posted", `Posted expense ${ref} to the ledger — voucher ${voucherNo}`, opts.actorId, voucherNo)
      }
      break
    }

    case "reject": {
      if (!opts.reason || !String(opts.reason).trim()) throw new Error("A rejection reason is required.")
      to = "Rejected"
      // Unwind any accrual that a prior approval posted.
      if (POSTED_STATES.includes(from) || from === "Approved") {
        await reverseExpensePosting(ref, { createdBy: opts.actorId })
      }
      await applyState(exp, to, { rejected_reason: String(opts.reason).trim() })
      await audit(exp, ref, "rejected", `Rejected expense ${ref} — ${String(opts.reason).trim()}`, opts.actorId)
      break
    }

    case "cancel": {
      if (String(exp.payment_status) === "Paid" || num(exp.amount_paid) > 0) {
        throw new Error("Cannot cancel an expense with recorded payments; reverse the payments first.")
      }
      to = "Cancelled"
      if (POSTED_STATES.includes(from) || from === "Approved") {
        await reverseExpensePosting(ref, { createdBy: opts.actorId })
      }
      await applyState(exp, to, { cancelled_reason: opts.reason ? String(opts.reason).trim() : null })
      await audit(exp, ref, "cancelled", `Cancelled expense ${ref}${opts.reason ? ` — ${String(opts.reason).trim()}` : ""}`, opts.actorId)
      break
    }

    case "reopen": {
      // Reopening a terminal expense requires a reason and is audited as an
      // override (Phase 44).
      if (!opts.reason || !String(opts.reason).trim()) throw new Error("A reason is required to reopen an expense.")
      to = "Draft"
      await applyState(exp, to, { rejected_reason: null, cancelled_reason: null, submitted_at: null })
      await audit(exp, ref, "reopened", `Reopened expense ${ref} to Draft — ${String(opts.reason).trim()}`, opts.actorId)
      break
    }
  }

  return { ok: true, expense_id: ref, from, to, voucher_no: voucherNo }
}

async function audit(
  exp: Record<string, any>,
  ref: string,
  type: Parameters<typeof logFinanceEvent>[0]["type"],
  summary: string,
  actorId: number,
  voucherNo?: string | null,
) {
  await logFinanceEvent({
    entityType: "expense",
    entityPk: Number(exp.id),
    entityRef: ref,
    type,
    summary,
    voucherNo: voucherNo ?? null,
    actorId,
  })
}
