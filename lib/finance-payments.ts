import { pool, query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { postLines } from "@/lib/finance-posting"
import { logFinanceEvent } from "@/lib/finance-audit"

/**
 * Payments & Accounts-Receivable engine (server-only) — Phase 2.
 *
 * A payment is an append-only record of cash actually received from a party. It
 * is applied against one or more sales invoices through `payment_allocations`,
 * and recording it posts the cash side of the entry to the ledger:
 *
 *   Dr Bank / Cash        (total received)
 *   Cr Accounts Receivable (total allocated)
 *
 * The ledger — not a free-text `amount_received` field — becomes the source of
 * truth for cash. Each affected invoice's amount_received / outstanding /
 * payment_status is then recomputed from the SUM of its ACTIVE allocations, so
 * the invoice always reflects real, reversible receipts.
 *
 * Reversing a payment (bounced cheque, wrong entry) posts a mirror voucher and
 * flips the invoices back. Money never comes from the browser: allocation
 * amounts are validated against each invoice's server-computed outstanding.
 *
 * Schema is self-creating + idempotent (same pattern as sales-invoice-db.ts) so
 * it works on databases where the migration runner has not applied
 * 2026-09-13-add-finance-payments.sql.
 */

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100

let ensured = false

export async function ensurePaymentsSchema() {
  if (ensured) return

  await query(
    `CREATE TABLE IF NOT EXISTS payments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      payment_id VARCHAR(40) NOT NULL,
      entity_type VARCHAR(40) NOT NULL DEFAULT 'sales_invoice',
      invoice_pk BIGINT UNSIGNED DEFAULT NULL,
      invoice_ref VARCHAR(40) DEFAULT NULL,
      party_id VARCHAR(40) DEFAULT NULL,
      party_name VARCHAR(255) DEFAULT NULL,
      payment_date DATE NOT NULL,
      financial_year VARCHAR(12) DEFAULT NULL,
      amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      payment_mode VARCHAR(20) NOT NULL DEFAULT 'Bank',
      deposit_role VARCHAR(10) NOT NULL DEFAULT 'bank',
      reference_no VARCHAR(120) DEFAULT NULL,
      narration VARCHAR(255) DEFAULT NULL,
      voucher_no VARCHAR(40) DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Active',
      reversal_voucher_no VARCHAR(40) DEFAULT NULL,
      reversal_reason VARCHAR(255) DEFAULT NULL,
      reversed_at TIMESTAMP NULL DEFAULT NULL,
      reversed_by BIGINT UNSIGNED DEFAULT NULL,
      idempotency_key VARCHAR(80) DEFAULT NULL,
      created_by BIGINT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_pay_payment_id (payment_id),
      UNIQUE KEY uq_pay_idempotency (idempotency_key),
      KEY idx_pay_invoice (invoice_pk),
      KEY idx_pay_status (status),
      KEY idx_pay_party (party_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  // One receipt → many invoice allocations. Keyed to the numeric payments.id and
  // sales_invoices.id so it survives display-id changes and joins cheaply.
  await query(
    `CREATE TABLE IF NOT EXISTS payment_allocations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      payment_pk BIGINT UNSIGNED NOT NULL,
      invoice_pk BIGINT UNSIGNED NOT NULL,
      invoice_ref VARCHAR(40) DEFAULT NULL,
      amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_alloc_payment (payment_pk),
      KEY idx_alloc_invoice (invoice_pk)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )

  ensured = true
}

// ---------------------------------------------------------------------------
// Invoice ↔ payment synchronisation
// ---------------------------------------------------------------------------

/**
 * Recompute an invoice's cash fields from the SUM of its ACTIVE allocations.
 * The invoice row mirrors the ledger; it is never trusted as the primary store.
 */
export async function recomputeInvoiceFromPayments(invoicePk: number): Promise<void> {
  const [inv] = (await query(
    `SELECT id, net_receivable, invoice_status FROM sales_invoices WHERE id = ? LIMIT 1`,
    [invoicePk],
  )) as any[]
  if (!inv) return

  const [agg] = (await query(
    `SELECT COALESCE(SUM(a.amount),0) AS received,
            MAX(p.payment_date) AS last_date
       FROM payment_allocations a
       JOIN payments p ON p.id = a.payment_pk
      WHERE a.invoice_pk = ? AND p.status = 'Active'`,
    [invoicePk],
  )) as any[]

  const received = round2(num(agg?.received))
  const net = round2(num(inv.net_receivable))
  const outstanding = round2(net - received)

  let status = "Unpaid"
  if (net > 0 && received >= net - 0.01) status = "Paid"
  else if (received > 0) status = "Partially Paid"

  // Most recent active payment reference, for the invoice's convenience columns.
  const [ref] = (await query(
    `SELECT p.payment_date, p.reference_no
       FROM payment_allocations a
       JOIN payments p ON p.id = a.payment_pk
      WHERE a.invoice_pk = ? AND p.status = 'Active'
      ORDER BY p.payment_date DESC, p.id DESC LIMIT 1`,
    [invoicePk],
  )) as any[]

  await query(
    `UPDATE sales_invoices
        SET amount_received = ?, outstanding_amount = ?, payment_status = ?,
            payment_date = ?, payment_reference = ?
      WHERE id = ?`,
    [received, outstanding, status, ref?.payment_date ?? null, ref?.reference_no ?? null, invoicePk],
  )
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type PaymentFilter = {
  status?: string
  party?: string
  from?: string
  to?: string
  search?: string
}

export async function listPayments(filter: PaymentFilter = {}) {
  await ensurePaymentsSchema()
  const where: string[] = []
  const args: any[] = []
  if (filter.status) {
    where.push("p.status = ?")
    args.push(filter.status)
  }
  if (filter.party) {
    where.push("p.party_name = ?")
    args.push(filter.party)
  }
  if (filter.from) {
    where.push("p.payment_date >= ?")
    args.push(filter.from)
  }
  if (filter.to) {
    where.push("p.payment_date <= ?")
    args.push(filter.to)
  }
  if (filter.search) {
    where.push("(p.payment_id LIKE ? OR p.party_name LIKE ? OR p.reference_no LIKE ?)")
    const s = `%${filter.search}%`
    args.push(s, s, s)
  }
  const rows = (await query(
    `SELECT p.*,
            (SELECT COUNT(*) FROM payment_allocations a WHERE a.payment_pk = p.id) AS allocation_count
       FROM payments p
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY p.payment_date DESC, p.id DESC
      LIMIT 500`,
    args,
  )) as any[]
  return rows
}

export async function getPaymentDetail(id: number) {
  await ensurePaymentsSchema()
  const [payment] = (await query(`SELECT * FROM payments WHERE id = ? LIMIT 1`, [id])) as any[]
  if (!payment) return null
  const allocations = (await query(
    `SELECT a.*, i.invoice_id, i.invoice_date, i.net_receivable, i.invoice_status
       FROM payment_allocations a
       LEFT JOIN sales_invoices i ON i.id = a.invoice_pk
      WHERE a.payment_pk = ? ORDER BY a.id ASC`,
    [id],
  )) as any[]
  return { ...payment, allocations }
}

/** Open (unpaid / partially paid) revenue invoices for a party, with outstanding. */
export async function getOutstandingInvoices(party?: string) {
  await ensurePaymentsSchema()
  const where: string[] = [
    "invoice_status IN ('Issued','Sent','Posted')",
    "invoice_type NOT IN ('Proforma Invoice','Credit Note')",
    "outstanding_amount > 0.001",
  ]
  const args: any[] = []
  if (party) {
    where.push("client_name = ?")
    args.push(party)
  }
  return (await query(
    `SELECT id, invoice_id, invoice_date, client_name, net_receivable, amount_received,
            outstanding_amount, due_date, payment_status, invoice_status
       FROM sales_invoices
      WHERE ${where.join(" AND ")}
      ORDER BY due_date IS NULL, due_date ASC, invoice_date ASC
      LIMIT 500`,
    args,
  )) as any[]
}

/** Receivable ageing buckets by due date (–82). */
export async function receivableAgeing(party?: string) {
  await ensurePaymentsSchema()
  const where: string[] = [
    "invoice_status IN ('Issued','Sent','Posted')",
    "invoice_type NOT IN ('Proforma Invoice','Credit Note')",
    "outstanding_amount > 0.001",
  ]
  const args: any[] = []
  if (party) {
    where.push("client_name = ?")
    args.push(party)
  }
  const rows = (await query(
    `SELECT client_name,
            COALESCE(SUM(outstanding_amount),0) AS total,
            COALESCE(SUM(CASE WHEN due_date IS NULL OR due_date >= CURDATE() THEN outstanding_amount ELSE 0 END),0) AS not_due,
            COALESCE(SUM(CASE WHEN due_date < CURDATE() AND DATEDIFF(CURDATE(), due_date) BETWEEN 1 AND 30 THEN outstanding_amount ELSE 0 END),0) AS d1_30,
            COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 31 AND 60 THEN outstanding_amount ELSE 0 END),0) AS d31_60,
            COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) BETWEEN 61 AND 90 THEN outstanding_amount ELSE 0 END),0) AS d61_90,
            COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) > 90 THEN outstanding_amount ELSE 0 END),0) AS d90_plus
       FROM sales_invoices
      WHERE ${where.join(" AND ")}
      GROUP BY client_name
      ORDER BY total DESC`,
    args,
  )) as any[]
  return rows.map((r) => ({
    client_name: r.client_name,
    total: round2(num(r.total)),
    not_due: round2(num(r.not_due)),
    d1_30: round2(num(r.d1_30)),
    d31_60: round2(num(r.d31_60)),
    d61_90: round2(num(r.d61_90)),
    d90_plus: round2(num(r.d90_plus)),
  }))
}

/** Chronological customer statement: invoices (debits) + payments (credits). */
export async function customerStatement(party: string) {
  await ensurePaymentsSchema()
  if (!party) return { party, lines: [], outstanding: 0 }

  const invoices = (await query(
    `SELECT invoice_id AS ref, invoice_date AS date, invoice_type,
            net_receivable AS debit
       FROM sales_invoices
      WHERE client_name = ? AND invoice_status IN ('Issued','Sent','Posted')
        AND invoice_type NOT IN ('Proforma Invoice')`,
    [party],
  )) as any[]

  const payments = (await query(
    `SELECT payment_id AS ref, payment_date AS date, amount AS credit
       FROM payments
      WHERE party_name = ? AND status = 'Active'`,
    [party],
  )) as any[]

  const lines = [
    ...invoices.map((r) => ({
      date: r.date,
      ref: r.ref,
      kind: r.invoice_type === "Credit Note" ? "Credit Note" : "Invoice",
      debit: r.invoice_type === "Credit Note" ? 0 : round2(num(r.debit)),
      credit: r.invoice_type === "Credit Note" ? round2(num(r.debit)) : 0,
    })),
    ...payments.map((r) => ({
      date: r.date,
      ref: r.ref,
      kind: "Payment",
      debit: 0,
      credit: round2(num(r.credit)),
    })),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)))

  let running = 0
  const withBalance = lines.map((l) => {
    running = round2(running + l.debit - l.credit)
    return { ...l, balance: running }
  })
  return { party, lines: withBalance, outstanding: running }
}

// ---------------------------------------------------------------------------
// Record a payment
// ---------------------------------------------------------------------------

export type AllocationInput = { invoice_pk: number; amount: number }

export type RecordPaymentInput = {
  party_id?: string | null
  party_name?: string | null
  payment_date: string
  payment_mode?: string
  deposit_role?: "bank" | "cash"
  reference_no?: string | null
  narration?: string | null
  financial_year?: string | null
  allocations: AllocationInput[]
  idempotency_key?: string | null
  created_by?: number | null
}

/**
 * Record a cash receipt applied across one or more invoices. Validates each
 * allocation against the invoice's server-side outstanding, posts the cash
 * voucher (Dr Bank/Cash, Cr AR), then recomputes every touched invoice. If the
 * ledger posting fails, the payment is rolled back so no orphan record remains.
 */
export async function recordPayment(input: RecordPaymentInput) {
  await ensurePaymentsSchema()

  const allocations = (input.allocations || [])
    .map((a) => ({ invoice_pk: Number(a.invoice_pk), amount: round2(num(a.amount)) }))
    .filter((a) => a.invoice_pk > 0 && a.amount > 0)

  if (allocations.length === 0) throw new Error("At least one invoice allocation with a positive amount is required.")

  // Idempotency: a retried submit with the same key returns the existing payment.
  if (input.idempotency_key) {
    const [dup] = (await query(`SELECT id, payment_id FROM payments WHERE idempotency_key = ? LIMIT 1`, [
      input.idempotency_key,
    ])) as any[]
    if (dup) return { id: Number(dup.id), payment_id: dup.payment_id, duplicate: true }
  }

  // Validate every target invoice up front (before opening the ledger txn).
  const invoicePks = allocations.map((a) => a.invoice_pk)
  const invoices = (await query(
    `SELECT id, invoice_id, client_name, net_receivable, outstanding_amount, invoice_status, invoice_type
       FROM sales_invoices WHERE id IN (${invoicePks.map(() => "?").join(",")})`,
    invoicePks,
  )) as any[]
  const byPk = new Map<number, any>(invoices.map((r) => [Number(r.id), r]))

  for (const a of allocations) {
    const inv = byPk.get(a.invoice_pk)
    if (!inv) throw new Error(`Invoice ${a.invoice_pk} not found.`)
    if (!["Issued", "Sent", "Posted"].includes(String(inv.invoice_status))) {
      throw new Error(`Invoice ${inv.invoice_id} is ${inv.invoice_status}; only Issued/Sent/Posted invoices can receive payment.`)
    }
    if (String(inv.invoice_type) === "Proforma Invoice" || String(inv.invoice_type) === "Credit Note") {
      throw new Error(`Invoice ${inv.invoice_id} (${inv.invoice_type}) cannot receive a payment.`)
    }
    // Over-allocation guard: allocation cannot exceed the invoice's outstanding.
    if (a.amount > round2(num(inv.outstanding_amount)) + 0.01) {
      throw new Error(
        `Allocation ${a.amount} exceeds the outstanding ${round2(num(inv.outstanding_amount))} on invoice ${inv.invoice_id}.`,
      )
    }
  }

  const total = round2(allocations.reduce((s, a) => s + a.amount, 0))
  const first = byPk.get(allocations[0].invoice_pk)
  const partyName = input.party_name || first?.client_name || null
  const depositRole = input.deposit_role === "cash" ? "cash" : "bank"
  const paymentDate = String(input.payment_date).slice(0, 10)

  const paymentDisplayId = await nextRecordId("PAY", { allowCustom: true })

  // Persist the payment + allocations first. If ledger posting throws we delete
  // them (compensating action) so a payment never exists without its voucher.
  const conn = await pool.getConnection()
  let paymentPk = 0
  try {
    await conn.beginTransaction()
    const [res] = await conn.query<any>(
      `INSERT INTO payments
         (payment_id, entity_type, invoice_pk, invoice_ref, party_id, party_name, payment_date,
          financial_year, amount, payment_mode, deposit_role, reference_no, narration, status,
          idempotency_key, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        paymentDisplayId, "sales_invoice", allocations[0].invoice_pk, first?.invoice_id ?? null,
        input.party_id ?? null, partyName, paymentDate, input.financial_year ?? null, total,
        input.payment_mode || (depositRole === "cash" ? "Cash" : "Bank"), depositRole,
        input.reference_no ?? null, input.narration ?? null, "Active",
        input.idempotency_key ?? null, input.created_by ?? null,
      ],
    )
    paymentPk = Number(res.insertId)
    for (const a of allocations) {
      const inv = byPk.get(a.invoice_pk)
      await conn.query(
        `INSERT INTO payment_allocations (payment_pk, invoice_pk, invoice_ref, amount) VALUES (?,?,?,?)`,
        [paymentPk, a.invoice_pk, inv?.invoice_id ?? null, a.amount],
      )
    }
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    conn.release()
    // Unique idempotency key collision under a race → treat as duplicate.
    if (input.idempotency_key && /Duplicate/i.test((error as Error).message)) {
      const [dup] = (await query(`SELECT id, payment_id FROM payments WHERE idempotency_key = ? LIMIT 1`, [
        input.idempotency_key,
      ])) as any[]
      if (dup) return { id: Number(dup.id), payment_id: dup.payment_id, duplicate: true }
    }
    throw error
  }
  conn.release()

  // Post the cash side: Dr Bank/Cash total, Cr Accounts Receivable total.
  try {
    const posting = await postLines(
      [
        { role: depositRole, debit: total, credit: 0 },
        { role: "receivable", debit: 0, credit: total },
      ],
      {
        entityType: "payment",
        entityId: paymentPk,
        entityRef: paymentDisplayId,
        date: paymentDate,
        financialYear: input.financial_year ?? null,
        partyId: input.party_id ?? null,
        partyName,
        voucherType: "Receipt",
        narration: `Receipt ${paymentDisplayId}${partyName ? ` from ${partyName}` : ""}`,
        sourceModule: "Payment",
        createdBy: input.created_by ?? null,
      },
    )
    await query(`UPDATE payments SET voucher_no = ? WHERE id = ?`, [posting.voucherNo, paymentPk])

    for (const a of allocations) await recomputeInvoiceFromPayments(a.invoice_pk)

    await logFinanceEvent({
      entityType: "payment",
      entityPk: paymentPk,
      entityRef: paymentDisplayId,
      type: "payment_recorded",
      summary: `Receipt ${paymentDisplayId} of ${total}${partyName ? ` from ${partyName}` : ""} across ${allocations.length} invoice(s)`,
      amount: total,
      voucherNo: posting.voucherNo,
      detail: { allocations },
      actorId: input.created_by ?? null,
    })
    return { id: paymentPk, payment_id: paymentDisplayId, voucher_no: posting.voucherNo, amount: total }
  } catch (error) {
    // Compensate: posting failed, so the payment must not survive.
    await query(`DELETE FROM payment_allocations WHERE payment_pk = ?`, [paymentPk])
    await query(`DELETE FROM payments WHERE id = ?`, [paymentPk])
    throw new Error(`Payment posting failed: ${(error as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// Reverse a payment
// ---------------------------------------------------------------------------

/** Reverse an active payment: post a mirror voucher and flip the invoices back. */
export async function reversePayment(id: number, reason: string, actorId?: number | null) {
  await ensurePaymentsSchema()
  const [payment] = (await query(`SELECT * FROM payments WHERE id = ? LIMIT 1`, [id])) as any[]
  if (!payment) throw new Error("Payment not found.")
  if (String(payment.status) !== "Active") throw new Error("Only an active payment can be reversed.")

  const total = round2(num(payment.amount))
  const depositRole = String(payment.deposit_role) === "cash" ? "cash" : "bank"

  const posting = await postLines(
    [
      { role: depositRole as any, debit: total, credit: 0 },
      { role: "receivable", debit: 0, credit: total },
    ],
    {
      entityType: "payment",
      entityId: Number(payment.id),
      entityRef: String(payment.payment_id),
      date: new Date().toISOString().slice(0, 10),
      financialYear: payment.financial_year ?? null,
      partyId: payment.party_id ?? null,
      partyName: payment.party_name ?? null,
      voucherType: "Receipt",
      narration: `Reversal of receipt ${payment.payment_id}${reason ? ` — ${reason}` : ""}`,
      sourceModule: "Payment",
      createdBy: actorId ?? null,
      reverse: true,
    },
  )

  await query(
    `UPDATE payments SET status = 'Reversed', reversal_voucher_no = ?, reversal_reason = ?,
        reversed_at = NOW(), reversed_by = ? WHERE id = ?`,
    [posting.voucherNo, reason || null, actorId ?? null, id],
  )

  const allocs = (await query(`SELECT invoice_pk FROM payment_allocations WHERE payment_pk = ?`, [id])) as any[]
  for (const a of allocs) await recomputeInvoiceFromPayments(Number(a.invoice_pk))

  await logFinanceEvent({
    entityType: "payment",
    entityPk: Number(id),
    entityRef: String(payment.payment_id),
    type: "reversed",
    summary: `Receipt ${payment.payment_id} reversed${reason ? `: ${reason}` : ""}`,
    amount: total,
    voucherNo: posting.voucherNo,
    actorId: actorId ?? null,
  })
  return { id, reversal_voucher_no: posting.voucherNo }
}
