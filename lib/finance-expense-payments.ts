import "server-only"
import { pool, query } from "@/lib/db"
import { num, round2 } from "@/lib/finance-calc"
import { nextRecordId } from "@/lib/record-ids"
import { postLines } from "@/lib/finance-posting"
import { logFinanceEvent } from "@/lib/finance-audit"
import { assertPeriodOpen } from "@/lib/finance-period-lock"
import { ensureExpensePostingAccounts } from "@/lib/finance-accounts"

/**
 * Expense payments & Accounts-Payable settlement engine (server-only).
 *
 * Under the accrual-on-post model, posting an expense already recognised the
 * liability (Cr <party> Payable). A payment is an append-only cash transaction
 * that CLEARS that payable — it never re-recognises the expense:
 *
 *   Payment  Dr <party> Payable   Cr Bank / Cash      (settle what is owed)
 *   Refund   Dr Bank / Cash       Cr <party> Payable  (money comes back in)
 *   Advance  Dr Employee Advance  Cr Bank / Cash      (prepay before the expense)
 *
 * The ledger is the source of truth for cash. Each expense's amount_paid /
 * outstanding_amount / payment_status is recomputed from the SUM of its ACTIVE
 * payment transactions (payments minus refunds), and the workflow_status is
 * advanced to Partially Paid / Paid accordingly. Payments are transaction-driven
 * and reversible — the free-text amount_paid field is never trusted.
 *
 * Amounts are validated server-side against the expense's own net_payable /
 * outstanding, so an over-payment can never be recorded from the browser.
 */

let ensured = false
export async function ensureExpensePaymentsSchema() {
  if (ensured) return
  await query(`CREATE TABLE IF NOT EXISTS expense_payments (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    payment_id    VARCHAR(40) NOT NULL,
    expense_pk    BIGINT UNSIGNED DEFAULT NULL,
    expense_ref   VARCHAR(40) DEFAULT NULL,
    payment_type  VARCHAR(12) NOT NULL DEFAULT 'Payment',
    party_id      VARCHAR(40) DEFAULT NULL,
    party_name    VARCHAR(255) DEFAULT NULL,
    payment_date  DATE NOT NULL,
    financial_year VARCHAR(12) DEFAULT NULL,
    amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
    payment_mode  VARCHAR(20) NOT NULL DEFAULT 'Bank',
    deposit_role  VARCHAR(10) NOT NULL DEFAULT 'bank',
    reference_no  VARCHAR(120) DEFAULT NULL,
    narration     VARCHAR(255) DEFAULT NULL,
    voucher_no    VARCHAR(40) DEFAULT NULL,
    status        VARCHAR(20) NOT NULL DEFAULT 'Active',
    reversal_voucher_no VARCHAR(40) DEFAULT NULL,
    reversal_reason VARCHAR(255) DEFAULT NULL,
    reversed_at   TIMESTAMP NULL DEFAULT NULL,
    reversed_by   BIGINT UNSIGNED DEFAULT NULL,
    idempotency_key VARCHAR(80) DEFAULT NULL,
    created_by    BIGINT UNSIGNED DEFAULT NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_exppay_payment_id (payment_id),
    UNIQUE KEY uq_exppay_idempotency (idempotency_key),
    KEY idx_exppay_expense (expense_pk),
    KEY idx_exppay_status (status),
    KEY idx_exppay_party (party_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  ensured = true
}

// ---------------------------------------------------------------------------
// Expense ↔ payment synchronisation
// ---------------------------------------------------------------------------

/**
 * Recompute an expense's cash fields from the SUM of its ACTIVE payment
 * transactions. Net settlement = payments − refunds; advances are prepayments
 * tracked separately and do not reduce this expense's outstanding. Also nudges
 * the workflow_status forward to Partially Paid / Paid (never backwards past a
 * reversed/cancelled state).
 */
export async function recomputeExpenseFromPayments(expensePk: number): Promise<void> {
  const [exp] = (await query(
    `SELECT id, expense_id, net_payable, workflow_status FROM expenses WHERE id = ? LIMIT 1`,
    [expensePk],
  )) as any[]
  if (!exp) return

  const [agg] = (await query(
    `SELECT
        COALESCE(SUM(CASE WHEN payment_type = 'Payment' THEN amount
                          WHEN payment_type = 'Refund'  THEN -amount ELSE 0 END),0) AS settled,
        MAX(CASE WHEN payment_type IN ('Payment','Refund') THEN payment_date END) AS last_date
       FROM expense_payments
      WHERE expense_pk = ? AND status = 'Active'`,
    [expensePk],
  )) as any[]

  const settled = round2(num(agg?.settled))
  const net = round2(num(exp.net_payable))
  const paid = round2(Math.max(settled, 0))
  const outstanding = round2(net - paid)

  let payStatus = "Unpaid"
  if (net > 0 && paid >= net - 0.01) payStatus = "Paid"
  else if (paid > 0) payStatus = "Partially Paid"

  // Advance the fine-grained workflow only from an already-posted/approved
  // state; do not resurrect a Rejected/Cancelled/Draft expense.
  const wf = String(exp.workflow_status || "")
  let nextWf = wf
  if (["Approved", "Posted", "Partially Paid", "Paid"].includes(wf)) {
    if (payStatus === "Paid") nextWf = "Paid"
    else if (payStatus === "Partially Paid") nextWf = "Partially Paid"
    else nextWf = "Posted"
  }

  const [ref] = (await query(
    `SELECT reference_no, payment_date FROM expense_payments
      WHERE expense_pk = ? AND status = 'Active' AND payment_type IN ('Payment','Refund')
      ORDER BY payment_date DESC, id DESC LIMIT 1`,
    [expensePk],
  )) as any[]

  await query(
    `UPDATE expenses
        SET amount_paid = ?, outstanding_amount = ?, payment_status = ?, workflow_status = ?,
            payment_reference = ?
      WHERE id = ?`,
    [paid, outstanding, payStatus, nextWf, ref?.reference_no ?? null, expensePk],
  ).catch(async () => {
    // payment_reference column may not exist on legacy expenses; retry without it.
    await query(
      `UPDATE expenses SET amount_paid = ?, outstanding_amount = ?, payment_status = ?, workflow_status = ? WHERE id = ?`,
      [paid, outstanding, payStatus, nextWf, expensePk],
    )
  })
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listExpensePayments(expensePk?: number) {
  await ensureExpensePaymentsSchema()
  if (expensePk) {
    return (await query(
      `SELECT * FROM expense_payments WHERE expense_pk = ? ORDER BY payment_date DESC, id DESC`,
      [expensePk],
    )) as any[]
  }
  return (await query(
    `SELECT * FROM expense_payments ORDER BY payment_date DESC, id DESC LIMIT 500`,
  )) as any[]
}

// ---------------------------------------------------------------------------
// Record a payment / refund / advance
// ---------------------------------------------------------------------------

export type RecordExpensePaymentInput = {
  expense_pk: number
  payment_type?: "Payment" | "Refund" | "Advance"
  payment_date: string
  amount: number
  payment_mode?: string
  deposit_role?: "bank" | "cash"
  reference_no?: string | null
  narration?: string | null
  idempotency_key?: string | null
  created_by?: number | null
}

/**
 * Record a cash transaction against an expense payable. Validates the amount
 * against the expense's server-side outstanding (for Payments), posts the cash
 * voucher, then recomputes the expense. On posting failure the transaction is
 * rolled back so no orphan record survives.
 */
export async function recordExpensePayment(input: RecordExpensePaymentInput) {
  await ensureExpensePaymentsSchema()
  await ensureExpensePostingAccounts()

  const type = input.payment_type || "Payment"
  const amount = round2(num(input.amount))
  if (amount <= 0) throw new Error("A positive payment amount is required.")

  const paymentDate = String(input.payment_date).slice(0, 10)
  await assertPeriodOpen(paymentDate)

  // Idempotency: a retried submit with the same key returns the existing record.
  if (input.idempotency_key) {
    const [dup] = (await query(`SELECT id, payment_id FROM expense_payments WHERE idempotency_key = ? LIMIT 1`, [
      input.idempotency_key,
    ])) as any[]
    if (dup) return { id: Number(dup.id), payment_id: dup.payment_id, duplicate: true }
  }

  const [exp] = (await query(`SELECT * FROM expenses WHERE id = ? LIMIT 1`, [input.expense_pk])) as any[]
  if (!exp) throw new Error(`Expense ${input.expense_pk} not found.`)

  const isEmployee = !!(exp.employee_id || exp.employee_name)
  const partyRole: "employee_payable" | "vendor_payable" = isEmployee ? "employee_payable" : "vendor_payable"
  const partyName = exp.employee_name || exp.vendor_name || exp.party_name || null
  const partyId = exp.employee_id || exp.vendor_id || null
  const depositRole = input.deposit_role === "cash" ? "cash" : "bank"

  // A settlement (Payment) requires a posted liability and cannot exceed the
  // expense's outstanding. Refunds cannot exceed what has been paid so far.
  if (type === "Payment") {
    if (String(exp.posting_status) !== "Posted") {
      throw new Error("This expense is not posted yet; approve/post it before recording a payment.")
    }
    const outstanding = round2(num(exp.outstanding_amount) || num(exp.net_payable) - num(exp.amount_paid))
    if (amount > outstanding + 0.01) {
      throw new Error(`Payment ${amount} exceeds the outstanding ${outstanding} on expense ${exp.expense_id}.`)
    }
  } else if (type === "Refund") {
    const paid = round2(num(exp.amount_paid))
    if (amount > paid + 0.01) {
      throw new Error(`Refund ${amount} exceeds the amount paid ${paid} on expense ${exp.expense_id}.`)
    }
  }

  const paymentDisplayId = await nextRecordId("EXPPAY", { allowCustom: true })

  // Persist the transaction first; delete it if the ledger posting throws.
  const conn = await pool.getConnection()
  let paymentPk = 0
  try {
    await conn.beginTransaction()
    const [res] = await conn.query<any>(
      `INSERT INTO expense_payments
         (payment_id, expense_pk, expense_ref, payment_type, party_id, party_name, payment_date,
          financial_year, amount, payment_mode, deposit_role, reference_no, narration, status,
          idempotency_key, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        paymentDisplayId, input.expense_pk, exp.expense_id ?? null, type, partyId, partyName, paymentDate,
        exp.financial_year ?? null, amount, input.payment_mode || (depositRole === "cash" ? "Cash" : "Bank"),
        depositRole, input.reference_no ?? null, input.narration ?? null, "Active",
        input.idempotency_key ?? null, input.created_by ?? null,
      ],
    )
    paymentPk = Number(res.insertId)
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    conn.release()
    if (input.idempotency_key && /Duplicate/i.test((error as Error).message)) {
      const [dup] = (await query(`SELECT id, payment_id FROM expense_payments WHERE idempotency_key = ? LIMIT 1`, [
        input.idempotency_key,
      ])) as any[]
      if (dup) return { id: Number(dup.id), payment_id: dup.payment_id, duplicate: true }
    }
    throw error
  }
  conn.release()

  // Post the cash voucher for this transaction type.
  try {
    const lines =
      type === "Refund"
        ? [
            { role: depositRole as any, debit: amount, credit: 0 },
            { role: partyRole, debit: 0, credit: amount },
          ]
        : type === "Advance"
          ? [
              { role: "employee_advance" as any, debit: amount, credit: 0 },
              { role: depositRole as any, debit: 0, credit: amount },
            ]
          : [
              { role: partyRole, debit: amount, credit: 0 },
              { role: depositRole as any, debit: 0, credit: amount },
            ]

    const posting = await postLines(lines, {
      entityType: "expense_payment",
      entityId: paymentPk,
      entityRef: paymentDisplayId,
      date: paymentDate,
      financialYear: exp.financial_year ?? null,
      partyId,
      partyName,
      voucherType: "Payment",
      narration: `${type} ${paymentDisplayId} for expense ${exp.expense_id}${partyName ? ` — ${partyName}` : ""}`,
      sourceModule: "Expense Payment",
      createdBy: input.created_by ?? null,
    })
    await query(`UPDATE expense_payments SET voucher_no = ? WHERE id = ?`, [posting.voucherNo, paymentPk])

    if (type !== "Advance") await recomputeExpenseFromPayments(input.expense_pk)

    await logFinanceEvent({
      entityType: "expense_payment",
      entityPk: paymentPk,
      entityRef: paymentDisplayId,
      type: "payment_recorded",
      summary: `${type} ${paymentDisplayId} of ${amount} on expense ${exp.expense_id}${partyName ? ` (${partyName})` : ""}`,
      amount,
      voucherNo: posting.voucherNo,
      actorId: input.created_by ?? null,
    })
    return { id: paymentPk, payment_id: paymentDisplayId, voucher_no: posting.voucherNo, amount }
  } catch (error) {
    await query(`DELETE FROM expense_payments WHERE id = ?`, [paymentPk])
    throw new Error(`Expense payment posting failed: ${(error as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// Reverse a payment
// ---------------------------------------------------------------------------

/** Reverse an active expense payment: post a mirror voucher and recompute. */
export async function reverseExpensePayment(id: number, reason: string, actorId?: number | null) {
  await ensureExpensePaymentsSchema()
  const [pay] = (await query(`SELECT * FROM expense_payments WHERE id = ? LIMIT 1`, [id])) as any[]
  if (!pay) throw new Error("Payment not found.")
  if (String(pay.status) !== "Active") throw new Error("Only an active payment can be reversed.")

  await assertPeriodOpen(pay.payment_date)

  const amount = round2(num(pay.amount))
  const depositRole = String(pay.deposit_role) === "cash" ? "cash" : "bank"
  const type = String(pay.payment_type)
  const isEmployee = !!pay.party_id || /employee/i.test(String(pay.narration))
  // Rebuild the original party role from the expense for accuracy.
  const [exp] = (await query(`SELECT employee_id, employee_name FROM expenses WHERE id = ? LIMIT 1`, [pay.expense_pk])) as any[]
  const partyRole: "employee_payable" | "vendor_payable" =
    exp && (exp.employee_id || exp.employee_name) ? "employee_payable" : isEmployee ? "employee_payable" : "vendor_payable"

  const lines =
    type === "Refund"
      ? [
          { role: depositRole as any, debit: amount, credit: 0 },
          { role: partyRole, debit: 0, credit: amount },
        ]
      : type === "Advance"
        ? [
            { role: "employee_advance" as any, debit: amount, credit: 0 },
            { role: depositRole as any, debit: 0, credit: amount },
          ]
        : [
            { role: partyRole, debit: amount, credit: 0 },
            { role: depositRole as any, debit: 0, credit: amount },
          ]

  const posting = await postLines(lines, {
    entityType: "expense_payment",
    entityId: Number(pay.id),
    entityRef: String(pay.payment_id),
    date: new Date().toISOString().slice(0, 10),
    financialYear: pay.financial_year ?? null,
    partyId: pay.party_id ?? null,
    partyName: pay.party_name ?? null,
    voucherType: "Payment",
    narration: `Reversal of ${type.toLowerCase()} ${pay.payment_id}${reason ? ` — ${reason}` : ""}`,
    sourceModule: "Expense Payment",
    createdBy: actorId ?? null,
    reverse: true,
  })

  await query(
    `UPDATE expense_payments
        SET status = 'Reversed', reversal_voucher_no = ?, reversal_reason = ?, reversed_at = NOW(), reversed_by = ?
      WHERE id = ?`,
    [posting.voucherNo, reason ?? null, actorId ?? null, id],
  )

  if (type !== "Advance") await recomputeExpenseFromPayments(Number(pay.expense_pk))

  await logFinanceEvent({
    entityType: "expense_payment",
    entityPk: Number(pay.id),
    entityRef: String(pay.payment_id),
    type: "payment_reversed",
    summary: `Reversed ${type.toLowerCase()} ${pay.payment_id} of ${amount}${reason ? ` — ${reason}` : ""}`,
    amount,
    voucherNo: posting.voucherNo,
    actorId: actorId ?? null,
  })
  return { id, reversal_voucher_no: posting.voucherNo }
}
