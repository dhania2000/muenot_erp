import "server-only"
import { query, tableColumns } from "@/lib/db"
import type { SessionPayload } from "@/lib/auth"
import { num, round2 } from "@/lib/finance-calc"
import { ensureExpenseColumns } from "@/lib/finance-ensure"
import { computeExpenseServerFields, nextExpenseId } from "@/lib/finance-expenses"
import { syncExpensePosting } from "@/lib/finance-expense-posting"
import { recordExpensePayment } from "@/lib/finance-expense-payments"
import { ensureExpenseSourceColumns } from "@/lib/recruit-finance-sync"
import { SEGREGATION_MESSAGE } from "@/lib/maker-checker-core"
import {
  SubscriptionError,
  computeRenewalTerms,
  loadSubscription,
  recordAudit,
  renewSubscription,
  type RenewalInput,
} from "@/lib/company-subscriptions"

/**
 * Company subscription renewals (#237/#238).
 *
 * A renewal commits company spend, so it runs maker-checker:
 *   request (maker) → approve/reject (a different user) → apply renewal
 *   → Finance Expense (vendor payable) → optional payment.
 *
 * Finance stays the single source of truth for money: the expense is written
 * through the same `computeExpenseServerFields` engine as the manual form and
 * linked by (source_module, source_ref = request_id), exactly like the
 * recruitment-cost sync. This is company purchasing only — Muenot SaaS
 * billing (lib/billing/*) is a separate ledger and is never touched here.
 *
 * Idempotency:
 *  - request: Idempotency-Key is UNIQUE, and `pending_guard` (= subscription id
 *    while Pending, NULL otherwise) allows at most one open request per
 *    subscription.
 *  - approve: an atomic `UPDATE … WHERE status='Pending'` claims the request, so
 *    concurrent approvals apply the renewal once. Posting is keyed on the
 *    request id and the payment on `subren:<request_id>`, so retrying a
 *    partially-failed approval completes it without duplicating records.
 */

export const RENEWAL_SOURCE_MODULE = "company_subscriptions"

export type RenewalRequestStatus = "Pending" | "Approved" | "Rejected" | "Cancelled"
export type PostingStatus = "NotPosted" | "Posted" | "Failed"

let schemaReady = false
export async function ensureRenewalSchema(): Promise<void> {
  if (schemaReady) return
  await query(`
    CREATE TABLE IF NOT EXISTS company_subscription_renewal_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      request_id VARCHAR(40) NOT NULL UNIQUE,
      subscription_id VARCHAR(40) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Pending',
      pending_guard VARCHAR(40) NULL,
      previous_end_date DATE NULL,
      new_end_date DATE NOT NULL,
      amount DECIMAL(15,2) NOT NULL DEFAULT 0,
      currency VARCHAR(10) NULL,
      remarks TEXT NULL,
      requested_by INT NOT NULL,
      requested_by_name VARCHAR(150) NULL,
      decided_by INT NULL,
      decided_by_name VARCHAR(150) NULL,
      decided_at DATETIME NULL,
      decision_note TEXT NULL,
      posting_status VARCHAR(20) NOT NULL DEFAULT 'NotPosted',
      posting_error VARCHAR(500) NULL,
      expense_id VARCHAR(40) NULL,
      payment_id VARCHAR(60) NULL,
      idempotency_key VARCHAR(120) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_csrr_pending (pending_guard),
      UNIQUE KEY uq_csrr_idem (idempotency_key),
      INDEX idx_csrr_sub (subscription_id, status)
    )
  `)
  schemaReady = true
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: string })?.code === "ER_DUP_ENTRY"
}

async function loadRequest(requestId: string): Promise<any | null> {
  const rows = (await query(
    `SELECT * FROM company_subscription_renewal_requests WHERE request_id = ? LIMIT 1`,
    [requestId],
  )) as any[]
  return rows[0] ?? null
}

export async function listRenewalRequests(subscriptionId?: string | null) {
  await ensureRenewalSchema()
  const rows = (await query(
    subscriptionId
      ? `SELECT * FROM company_subscription_renewal_requests WHERE subscription_id = ? ORDER BY id DESC LIMIT 200`
      : `SELECT * FROM company_subscription_renewal_requests ORDER BY (status = 'Pending') DESC, id DESC LIMIT 200`,
    subscriptionId ? [subscriptionId] : [],
  )) as any[]
  return rows
}

export async function requestRenewal(
  subscriptionId: string,
  input: RenewalInput,
  session: SessionPayload,
  idempotencyKey: string | null,
) {
  await ensureRenewalSchema()
  if (idempotencyKey) {
    const rows = (await query(
      `SELECT * FROM company_subscription_renewal_requests WHERE idempotency_key = ? LIMIT 1`,
      [idempotencyKey],
    )) as any[]
    if (rows[0]) {
      if (rows[0].subscription_id !== subscriptionId)
        throw new SubscriptionError("Idempotency-Key was already used for a different subscription.", 409)
      return { request: rows[0], replayed: true }
    }
  }

  const current = await loadSubscription(subscriptionId)
  if (!current) throw new SubscriptionError("Subscription not found.", 404)
  const terms = computeRenewalTerms(current, input)
  const remarks = input.remarks ? String(input.remarks).slice(0, 2000) : null
  const requestId = `SRR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

  try {
    await query(
      `INSERT INTO company_subscription_renewal_requests
        (request_id, subscription_id, status, pending_guard, previous_end_date, new_end_date, amount, currency,
         remarks, requested_by, requested_by_name, idempotency_key)
       VALUES (?, ?, 'Pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        requestId,
        subscriptionId,
        subscriptionId,
        terms.previousEnd,
        terms.newEnd,
        terms.amount,
        current.currency ?? null,
        remarks,
        session.userId,
        session.name ?? null,
        idempotencyKey,
      ],
    )
  } catch (err) {
    if (isDuplicateKey(err)) {
      if (idempotencyKey) {
        const rows = (await query(
          `SELECT * FROM company_subscription_renewal_requests WHERE idempotency_key = ? LIMIT 1`,
          [idempotencyKey],
        )) as any[]
        if (rows[0]) return { request: rows[0], replayed: true }
      }
      throw new SubscriptionError("A renewal request is already pending for this subscription.", 409)
    }
    throw err
  }

  await recordAudit({
    subscriptionId,
    action: "Renewal Requested",
    userId: session.userId,
    userName: session.name ?? null,
    reason: `Request ${requestId}: renew to ${terms.newEnd} for ${terms.amount}${remarks ? ` — ${remarks}` : ""}`,
  })
  return { request: await loadRequest(requestId), replayed: false }
}

export type ApproveOptions = {
  note?: string | null
  payment?: { payment_date: string; payment_mode?: string; reference_no?: string | null } | null
}

export async function decideRenewal(
  requestId: string,
  decision: "approve" | "reject" | "cancel",
  session: SessionPayload,
  opts: ApproveOptions = {},
) {
  await ensureRenewalSchema()
  const req = await loadRequest(requestId)
  if (!req) throw new SubscriptionError("Renewal request not found.", 404)
  const note = opts.note ? String(opts.note).slice(0, 2000) : null

  if (decision === "cancel") {
    if (Number(req.requested_by) !== Number(session.userId) && session.role !== "admin")
      throw new SubscriptionError("Only the requester can cancel this request.", 403)
    return closeRequest(req, "Cancelled", session, note)
  }

  // Segregation of duties: the maker can never approve or reject their own request.
  if (Number(req.requested_by) === Number(session.userId)) throw new SubscriptionError(SEGREGATION_MESSAGE, 403)

  if (decision === "reject") return closeRequest(req, "Rejected", session, note)

  if (req.status === "Approved") {
    // Idempotent retry: finish any posting that failed after approval.
    if (req.posting_status !== "Posted") await postApprovedRenewal(req, session, opts.payment ?? null)
    return { request: await loadRequest(requestId), replayed: true }
  }
  if (req.status !== "Pending") throw new SubscriptionError(`Request is already ${req.status}.`, 409)

  const claim = (await query(
    `UPDATE company_subscription_renewal_requests
        SET status = 'Approved', pending_guard = NULL, decided_by = ?, decided_by_name = ?, decided_at = NOW(),
            decision_note = ?
      WHERE id = ? AND status = 'Pending'`,
    [session.userId, session.name ?? null, note, req.id],
  )) as { affectedRows?: number }
  if (!claim?.affectedRows) {
    const latest = await loadRequest(requestId)
    return { request: latest, replayed: true }
  }

  try {
    await renewSubscription(
      req.subscription_id,
      { new_end_date: String(req.new_end_date).slice(0, 10), amount: req.amount, remarks: `Approved renewal ${requestId}` },
      session,
    )
  } catch (err) {
    // Release the claim so the request can be retried or rejected; nothing was posted.
    await query(
      `UPDATE company_subscription_renewal_requests
          SET status = 'Pending', pending_guard = subscription_id, decided_by = NULL, decided_by_name = NULL,
              decided_at = NULL
        WHERE id = ?`,
      [req.id],
    )
    throw err
  }

  await postApprovedRenewal({ ...req, status: "Approved" }, session, opts.payment ?? null)
  return { request: await loadRequest(requestId), replayed: false }
}

async function closeRequest(req: any, status: "Rejected" | "Cancelled", session: SessionPayload, note: string | null) {
  if (req.status === status) return { request: req, replayed: true }
  if (req.status !== "Pending") throw new SubscriptionError(`Request is already ${req.status}.`, 409)
  await query(
    `UPDATE company_subscription_renewal_requests
        SET status = ?, pending_guard = NULL, decided_by = ?, decided_by_name = ?, decided_at = NOW(), decision_note = ?
      WHERE id = ? AND status = 'Pending'`,
    [status, session.userId, session.name ?? null, note, req.id],
  )
  await recordAudit({
    subscriptionId: req.subscription_id,
    action: `Renewal ${status}`,
    userId: session.userId,
    userName: session.name ?? null,
    reason: `Request ${req.request_id}${note ? ` — ${note}` : ""}`,
  })
  return { request: await loadRequest(req.request_id), replayed: false }
}

/**
 * Post an approved renewal to Finance: an Approved vendor expense (payable),
 * GL posting through the Finance engine, and an optional payment. Each step is
 * keyed so a retry resumes without duplicating. Posting failures never undo
 * the approval — they are recorded and surfaced for retry.
 */
async function postApprovedRenewal(req: any, session: SessionPayload, payment: ApproveOptions["payment"]) {
  const requestId = String(req.request_id)
  try {
    const sub = await loadSubscription(req.subscription_id)
    const expense = await upsertRenewalExpense(req, sub, session)
    if (expense.gross > 0) await syncExpensePosting(expense.expenseId, { createdBy: session.userId })

    let paymentId: string | null = req.payment_id ?? null
    if (payment && !paymentId && expense.gross > 0) {
      const result: any = await recordExpensePayment({
        expense_pk: expense.pk,
        payment_type: "Payment",
        payment_date: payment.payment_date,
        amount: expense.gross,
        payment_mode: payment.payment_mode || "Bank Transfer",
        reference_no: payment.reference_no ?? requestId,
        narration: `Subscription renewal ${requestId}`,
        idempotency_key: `subren:${requestId}`,
        created_by: session.userId,
      })
      paymentId = String(result?.payment?.payment_id ?? result?.payment_id ?? result?.id ?? `subren:${requestId}`)
    }

    await query(
      `UPDATE company_subscription_renewal_requests
          SET posting_status = 'Posted', posting_error = NULL, expense_id = ?, payment_id = ?
        WHERE id = ?`,
      [expense.expenseId, paymentId, req.id],
    )
    await recordAudit({
      subscriptionId: req.subscription_id,
      action: "Renewal Posted",
      userId: session.userId,
      userName: session.name ?? null,
      reason: `Request ${requestId} → expense ${expense.expenseId}${paymentId ? `, payment ${paymentId}` : ""}`,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Finance posting failed"
    console.error("[v0] subscription renewal posting failed:", requestId, message)
    await query(
      `UPDATE company_subscription_renewal_requests SET posting_status = 'Failed', posting_error = ? WHERE id = ?`,
      [message.slice(0, 500), req.id],
    ).catch(() => {})
  }
}

async function upsertRenewalExpense(req: any, sub: any, session: SessionPayload) {
  await ensureExpenseColumns()
  await ensureExpenseSourceColumns()
  const requestId = String(req.request_id)
  const existing = ((await query(
    `SELECT * FROM expenses WHERE source_module = ? AND source_ref = ? LIMIT 1`,
    [RENEWAL_SOURCE_MODULE, requestId],
  )) as any[])[0]

  const amount = round2(num(req.amount))
  const expenseDate = new Date().toISOString().slice(0, 10)
  const vendorName = sub?.vendor_name ?? sub?.vendor ?? null
  const base: Record<string, any> = {
    ...(existing ?? {}),
    expense_type: vendorName || sub?.vendor_id ? "Vendor Expense" : "Business Expense",
    expense_date: existing?.expense_date ? String(existing.expense_date).slice(0, 10) : expenseDate,
    expense_category: "Software & Subscriptions",
    description: `Renewal of ${sub?.name ?? sub?.subscription_name ?? req.subscription_id} until ${String(req.new_end_date).slice(0, 10)}`,
    reference_number: requestId,
    vendor_id: sub?.vendor_id ?? null,
    vendor_name: vendorName,
    quantity: 1,
    rate: amount,
    taxable_amount: amount,
    approval_status: "Approved",
    source_module: RENEWAL_SOURCE_MODULE,
    source_ref: requestId,
  }
  const computed = await computeExpenseServerFields(base, { isCreate: !existing })
  const merged: Record<string, any> = { ...base, ...computed }
  const cols = await tableColumns("expenses")
  if (cols.has("approved_by")) merged.approved_by = req.decided_by ?? session.userId

  let expenseId = existing?.expense_id ? String(existing.expense_id) : ""
  let pk = existing?.id ? Number(existing.id) : 0
  if (existing) {
    const updatable = Object.keys(merged).filter((k) => cols.has(k) && k !== "id" && k !== "expense_id")
    if (updatable.length)
      await query(`UPDATE expenses SET ${updatable.map((c) => `${c}=?`).join(",")} WHERE id = ?`, [
        ...updatable.map((c) => merged[c]),
        existing.id,
      ])
  } else {
    expenseId = await nextExpenseId(merged.expense_date)
    merged.expense_id = expenseId
    if (cols.has("created_by")) merged.created_by = session.userId
    const insertable = Object.keys(merged).filter((k) => cols.has(k) && k !== "id")
    const res = (await query(
      `INSERT INTO expenses (${insertable.join(",")}) VALUES (${insertable.map(() => "?").join(",")})`,
      insertable.map((c) => merged[c]),
    )) as { insertId?: number }
    pk = Number(res?.insertId ?? 0)
  }
  const gross = round2(num(merged.gross_amount) || amount)
  return { expenseId, pk, gross }
}
