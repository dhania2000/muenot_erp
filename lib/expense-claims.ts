import "server-only"
import { pool, query, tableColumns } from "@/lib/db"
import { getCurrentTenant } from "@/lib/tenant-context"
import type { SessionPayload } from "@/lib/auth"
import { computeExpenseServerFields, nextExpenseId } from "@/lib/finance-expenses"
import { syncExpensePosting } from "@/lib/finance-expense-posting"
import { financialYearFor } from "@/lib/finance-calc"
import {
  type ClaimLine,
  type ClaimStatus,
  type PolicyViolation,
  computeClaimTotals,
  computeLineAmount,
  validateClaim,
  hasBlockingViolations,
  planReimbursement,
} from "@/lib/expense-claims-core"
import { recordExpensePayment } from "@/lib/finance-expense-payments"
import { recordAuditLog } from "@/lib/audit-log-store"

/**
 * Expense Claims server engine (SPEC 127 — Phases 2–4).
 *
 * Owns the employee-facing expense-claim lifecycle and the parts that must
 * never be trusted to the browser: the immutable claim id, the frozen employee
 * snapshot, the authoritative money recomputation, the policy gate, the
 * approval state machine and the projection into Finance.
 *
 * Finance is NOT re-implemented here. On approval a claim is projected into the
 * existing, proven Finance → Expenses engine as an employee "Reimbursement"
 * expense, which posts the balanced accrual (Dr expense / Cr Employee
 * Reimbursements Payable) through `syncExpensePosting`. This keeps a single
 * accounting source of truth.
 */

const TABLE = "hr_expense_claims"
let ensured = false

export async function ensureExpenseClaimSchema(): Promise<void> {
  if (ensured) return
  await query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id INT UNSIGNED DEFAULT NULL,
    claim_id VARCHAR(30) NOT NULL,
    title VARCHAR(190) DEFAULT NULL,
    employee_id VARCHAR(40) DEFAULT NULL,
    employee_name VARCHAR(190) DEFAULT NULL,
    department VARCHAR(120) DEFAULT NULL,
    designation VARCHAR(120) DEFAULT NULL,
    employee_email VARCHAR(190) DEFAULT NULL,
    employee_manager VARCHAR(160) DEFAULT NULL,
    claim_date DATE DEFAULT NULL,
    period_from DATE DEFAULT NULL,
    period_to DATE DEFAULT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'Draft',
    \`lines\` LONGTEXT DEFAULT NULL,
    gross_total DECIMAL(14,2) NOT NULL DEFAULT 0,
    reimbursable_total DECIMAL(14,2) NOT NULL DEFAULT 0,
    corporate_card_total DECIMAL(14,2) NOT NULL DEFAULT 0,
    mileage_total DECIMAL(14,2) NOT NULL DEFAULT 0,
    policy_violations LONGTEXT DEFAULT NULL,
    notes TEXT DEFAULT NULL,
    submitted_at DATETIME DEFAULT NULL,
    approved_at DATETIME DEFAULT NULL,
    approved_by_id INT DEFAULT NULL,
    approved_by_name VARCHAR(190) DEFAULT NULL,
    rejected_reason VARCHAR(500) DEFAULT NULL,
    finance_expense_id VARCHAR(30) DEFAULT NULL,
    voucher_no VARCHAR(40) DEFAULT NULL,
    posted_at DATETIME DEFAULT NULL,
    reimbursed_at DATETIME DEFAULT NULL,
    reimbursement_reference VARCHAR(120) DEFAULT NULL,
    created_by INT DEFAULT NULL,
    created_by_name VARCHAR(190) DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_claim_id (claim_id),
    KEY idx_claim_tenant (tenant_id),
    KEY idx_claim_employee (employee_id),
    KEY idx_claim_status (status),
    KEY idx_claim_creator (created_by)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  // Migration: partial reimbursement tracking (added after the initial table).
  const cols = await Promise.resolve(tableColumns(TABLE)).catch(() => null)
  if (cols && cols.size && !cols.has("reimbursed_amount")) {
    await Promise.resolve(
      query(`ALTER TABLE ${TABLE} ADD COLUMN reimbursed_amount DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER reimbursed_at`),
    ).catch(() => undefined)
  }
  ensured = true
}

function tenantId(): number | null {
  return getCurrentTenant()?.tenantId ?? null
}

/** FY-scoped, concurrency-safe claim id: `ECL-2026-000001`. */
async function nextClaimId(dateStr?: string | null): Promise<string> {
  const d = dateStr ? new Date(dateStr) : new Date()
  const year = Number.isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear()
  const seqKey = `ECL${year}`
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.query(
      "INSERT INTO record_id_sequences (prefix, next_number) VALUES (?, 1) ON DUPLICATE KEY UPDATE next_number = next_number + 1",
      [seqKey],
    )
    const [rows] = await connection.query<any[]>(
      "SELECT next_number FROM record_id_sequences WHERE prefix = ? FOR UPDATE",
      [seqKey],
    )
    const number = Number(rows[0]?.next_number || 1)
    await connection.commit()
    return `ECL-${year}-${String(number).padStart(6, "0")}`
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

export type ResolvedEmployee = {
  employee_id: string | null
  employee_name: string | null
  department: string | null
  designation: string | null
  employee_email: string | null
  employee_manager: string | null
}

/** Resolve the employee record linked to the acting user (self-service). */
export async function resolveSessionEmployee(userId: number): Promise<ResolvedEmployee | null> {
  const rows = (await query(
    `SELECT employee_id, employee_name, department, designation, official_email, reporting_manager
       FROM hr_employees WHERE user_id = ? LIMIT 1`,
    [userId],
  )) as any[]
  const e = rows[0]
  if (!e) return null
  return {
    employee_id: e.employee_id ?? null,
    employee_name: e.employee_name ?? null,
    department: e.department ?? null,
    designation: e.designation ?? null,
    employee_email: e.official_email ?? null,
    employee_manager: e.reporting_manager ?? null,
  }
}

/** Employees pickable by an approver/admin when raising a claim on behalf. */
export async function listEmployees(): Promise<ResolvedEmployee[]> {
  const rows = (await query(
    `SELECT employee_id, employee_name, department, designation, official_email, reporting_manager
       FROM hr_employees
      WHERE COALESCE(exit_status,'') <> 'Exited'
      ORDER BY employee_name ASC LIMIT 1000`,
  )) as any[]
  return rows.map((e) => ({
    employee_id: e.employee_id ?? null,
    employee_name: e.employee_name ?? null,
    department: e.department ?? null,
    designation: e.designation ?? null,
    employee_email: e.official_email ?? null,
    employee_manager: e.reporting_manager ?? null,
  }))
}

export type ClaimRow = Record<string, any> & { lines: ClaimLine[]; policy_violations: PolicyViolation[] }

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback
  if (typeof raw === "object") return raw as T
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    return fallback
  }
}

function hydrate(row: any): ClaimRow {
  return {
    ...row,
    lines: parseJson<ClaimLine[]>(row.lines, []),
    policy_violations: parseJson<PolicyViolation[]>(row.policy_violations, []),
  }
}

export async function listClaims(session: SessionPayload): Promise<ClaimRow[]> {
  await ensureExpenseClaimSchema()
  const tid = tenantId()
  const where: string[] = ["(tenant_id = ? OR tenant_id IS NULL)"]
  const params: any[] = [tid]
  // Employees only see their own claims; admins see the whole tenant.
  if (session.role !== "admin") {
    where.push("(created_by = ? OR employee_id = ?)")
    const me = await resolveSessionEmployee(session.userId)
    params.push(session.userId, me?.employee_id ?? "__none__")
  }
  const rows = (await query(
    `SELECT * FROM ${TABLE} WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT 500`,
    params,
  )) as any[]
  return rows.map(hydrate)
}

export async function getClaim(idOrRef: string | number, session: SessionPayload): Promise<ClaimRow | null> {
  await ensureExpenseClaimSchema()
  const byRef = typeof idOrRef === "string" && idOrRef.startsWith("ECL-")
  const rows = (await query(
    `SELECT * FROM ${TABLE} WHERE ${byRef ? "claim_id" : "id"} = ? AND (tenant_id = ? OR tenant_id IS NULL) LIMIT 1`,
    [idOrRef, tenantId()],
  )) as any[]
  const row = rows[0]
  if (!row) return null
  const claim = hydrate(row)
  if (session.role !== "admin") {
    const me = await resolveSessionEmployee(session.userId)
    const owns = Number(claim.created_by) === session.userId || (me?.employee_id && claim.employee_id === me.employee_id)
    if (!owns) return null
  }
  return claim
}

type ClaimInput = {
  title?: string
  employee?: ResolvedEmployee | null
  claim_date?: string
  period_from?: string | null
  period_to?: string | null
  notes?: string | null
  lines?: ClaimLine[]
}

/** Normalise a line: server always recomputes the amount (never trusts it). */
function normaliseLine(line: ClaimLine): ClaimLine {
  const clean: ClaimLine = {
    category: String(line.category ?? "").trim(),
    description: String(line.description ?? "").trim(),
    date: String(line.date ?? "").slice(0, 10),
    amount: 0,
    is_mileage: !!line.is_mileage,
    corporate_card: !!line.corporate_card,
    card_last4: line.card_last4 ? String(line.card_last4).replace(/\D/g, "").slice(-4) : undefined,
    receipt_url: line.receipt_url ? String(line.receipt_url) : null,
  }
  if (clean.is_mileage) {
    clean.distance_km = Math.max(0, Number(line.distance_km) || 0)
    clean.mileage_rate = Math.max(0, Number(line.mileage_rate) || 0)
  } else {
    clean.amount = Math.max(0, Number(line.amount) || 0)
  }
  // Freeze the authoritative amount so downstream reads never re-derive.
  clean.amount = computeLineAmount(clean)
  return clean
}

async function resolveEmployeeForWrite(
  input: ClaimInput,
  session: SessionPayload,
): Promise<ResolvedEmployee> {
  // Admins may raise on behalf of a chosen employee; everyone else is self.
  if (session.role === "admin" && input.employee?.employee_id) {
    const all = await listEmployees()
    const match = all.find((e) => e.employee_id === input.employee?.employee_id)
    if (match) return match
  }
  const me = await resolveSessionEmployee(session.userId)
  return (
    me ?? {
      employee_id: null,
      employee_name: session.name,
      department: null,
      designation: null,
      employee_email: session.email,
      employee_manager: null,
    }
  )
}

export async function createClaim(input: ClaimInput, session: SessionPayload): Promise<ClaimRow> {
  await ensureExpenseClaimSchema()
  const employee = await resolveEmployeeForWrite(input, session)
  const lines = (input.lines || []).map(normaliseLine)
  const totals = computeClaimTotals(lines)
  const claimDate = (input.claim_date || new Date().toISOString().slice(0, 10)).slice(0, 10)
  const violations = validateClaim(lines, { today: new Date().toISOString().slice(0, 10) })
  const claimId = await nextClaimId(claimDate)

  await query(
    `INSERT INTO ${TABLE}
      (tenant_id, claim_id, title, employee_id, employee_name, department, designation,
       employee_email, employee_manager, claim_date, period_from, period_to, status, \`lines\`,
       gross_total, reimbursable_total, corporate_card_total, mileage_total, policy_violations,
       notes, created_by, created_by_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      tenantId(),
      claimId,
      input.title?.trim() || null,
      employee.employee_id,
      employee.employee_name,
      employee.department,
      employee.designation,
      employee.employee_email,
      employee.employee_manager,
      claimDate,
      input.period_from || null,
      input.period_to || null,
      "Draft",
      JSON.stringify(lines),
      totals.gross,
      totals.reimbursable,
      totals.corporateCard,
      totals.mileage,
      JSON.stringify(violations),
      input.notes?.trim() || null,
      session.userId,
      session.name,
    ],
  )
  const created = await getClaim(claimId, session)
  if (!created) throw new Error("Claim creation failed")
  return created
}

export async function updateClaim(
  id: number | string,
  input: ClaimInput,
  session: SessionPayload,
): Promise<ClaimRow> {
  const existing = await getClaim(id, session)
  if (!existing) throw new Error("Claim not found")
  if (!["Draft", "Rejected"].includes(String(existing.status))) {
    throw new Error(`A ${existing.status} claim can no longer be edited.`)
  }
  const employee = await resolveEmployeeForWrite(input, session)
  const lines = (input.lines || []).map(normaliseLine)
  const totals = computeClaimTotals(lines)
  const violations = validateClaim(lines, { today: new Date().toISOString().slice(0, 10) })

  await query(
    `UPDATE ${TABLE} SET
       title = ?, employee_id = ?, employee_name = ?, department = ?, designation = ?,
       employee_email = ?, employee_manager = ?, claim_date = ?, period_from = ?, period_to = ?,
       \`lines\` = ?, gross_total = ?, reimbursable_total = ?, corporate_card_total = ?,
       mileage_total = ?, policy_violations = ?, notes = ?,
       status = CASE WHEN status = 'Rejected' THEN 'Draft' ELSE status END,
       rejected_reason = CASE WHEN status = 'Rejected' THEN NULL ELSE rejected_reason END
     WHERE id = ?`,
    [
      input.title?.trim() || null,
      employee.employee_id,
      employee.employee_name,
      employee.department,
      employee.designation,
      employee.employee_email,
      employee.employee_manager,
      (input.claim_date || existing.claim_date || new Date().toISOString().slice(0, 10)).slice(0, 10),
      input.period_from || null,
      input.period_to || null,
      JSON.stringify(lines),
      totals.gross,
      totals.reimbursable,
      totals.corporateCard,
      totals.mileage,
      JSON.stringify(violations),
      input.notes?.trim() || null,
      existing.id,
    ],
  )
  const updated = await getClaim(existing.id, session)
  if (!updated) throw new Error("Claim update failed")
  return updated
}

export async function deleteClaim(id: number | string, session: SessionPayload): Promise<void> {
  const existing = await getClaim(id, session)
  if (!existing) throw new Error("Claim not found")
  if (!["Draft", "Rejected", "Cancelled"].includes(String(existing.status))) {
    throw new Error(`A ${existing.status} claim cannot be deleted.`)
  }
  await query(`DELETE FROM ${TABLE} WHERE id = ?`, [existing.id])
}

// ---------------------------------------------------------------------------
// Workflow state machine
// ---------------------------------------------------------------------------

export type ClaimAction = "submit" | "approve" | "reject" | "reimburse" | "cancel" | "reopen"

const TRANSITIONS: Record<ClaimAction, { from: ClaimStatus[]; to: ClaimStatus }> = {
  submit: { from: ["Draft", "Rejected"], to: "Submitted" },
  approve: { from: ["Submitted"], to: "Approved" },
  reject: { from: ["Submitted"], to: "Rejected" },
  reimburse: { from: ["Approved", "Partially Reimbursed"], to: "Reimbursed" },
  cancel: { from: ["Draft", "Submitted", "Rejected"], to: "Cancelled" },
  reopen: { from: ["Rejected", "Cancelled"], to: "Draft" },
}

/** Actions only an approver (admin) may perform. */
const APPROVER_ACTIONS = new Set<ClaimAction>(["approve", "reject", "reimburse"])

export async function transitionClaim(
  idOrRef: string | number,
  action: ClaimAction,
  session: SessionPayload,
  opts: {
    reason?: string | null
    reference?: string | null
    amount?: number | null
    payment_date?: string | null
    deposit_role?: "bank" | "cash"
    idempotency_key?: string | null
  } = {},
): Promise<ClaimRow> {
  const claim = await getClaim(idOrRef, session)
  if (!claim) throw new Error("Claim not found")

  const rule = TRANSITIONS[action]
  if (!rule) throw new Error("Unknown action.")
  if (!rule.from.includes(String(claim.status) as ClaimStatus)) {
    throw new Error(`Cannot ${action} a claim that is ${claim.status}.`)
  }

  const isApprover = session.role === "admin"
  if (APPROVER_ACTIONS.has(action) && !isApprover) {
    throw new Error("Only an approver can perform this action.")
  }
  // Segregation of duties — an approver cannot approve their own claim.
  if (APPROVER_ACTIONS.has(action) && Number(claim.created_by) === session.userId) {
    throw new Error("You cannot approve or reimburse a claim you raised (segregation of duties).")
  }

  if (action === "submit") {
    if (hasBlockingViolations(claim.policy_violations)) {
      throw new Error("Resolve the policy violations before submitting this claim.")
    }
    if (!claim.lines.length) throw new Error("Add at least one expense line before submitting.")
    await query(`UPDATE ${TABLE} SET status = ?, submitted_at = NOW() WHERE id = ?`, [rule.to, claim.id])
  } else if (action === "approve") {
    // Phase 4 — project into Finance and post the balanced accrual.
    const posted = await postClaimToFinance(claim, session)
    await query(
      `UPDATE ${TABLE} SET status = ?, approved_at = NOW(), approved_by_id = ?, approved_by_name = ?,
         finance_expense_id = ?, voucher_no = ?, posted_at = NOW() WHERE id = ?`,
      [rule.to, session.userId, session.name, posted.expenseId, posted.voucherNo, claim.id],
    )
  } else if (action === "reject") {
    await query(`UPDATE ${TABLE} SET status = ?, rejected_reason = ? WHERE id = ?`, [
      rule.to,
      opts.reason || "No reason provided.",
      claim.id,
    ])
  } else if (action === "reimburse") {
    await reimburseClaim(claim, session, opts)
  } else if (action === "cancel") {
    await query(`UPDATE ${TABLE} SET status = ? WHERE id = ?`, [rule.to, claim.id])
  } else if (action === "reopen") {
    await query(`UPDATE ${TABLE} SET status = ? WHERE id = ?`, [rule.to, claim.id])
  }

  const next = await getClaim(claim.id, session)
  if (!next) throw new Error("Claim reload failed")
  await recordAuditLog({
    action: `expense_claim.${action}`,
    entityType: "hr_expense_claim",
    entityId: claim.id,
    entityLabel: claim.claim_id,
    before: { status: claim.status, reimbursed_amount: Number(claim.reimbursed_amount) || 0 },
    after: { status: next.status, reimbursed_amount: Number(next.reimbursed_amount) || 0 },
    metadata: { reason: opts.reason ?? null, reference: opts.reference ?? null, amount: opts.amount ?? null },
  })
  return next
}

/**
 * Settle an approved claim — fully or partially — by recording a real cash
 * payment against the linked Finance expense (Dr Employee Reimbursements
 * Payable / Cr Bank|Cash). The payment date may fall in a later accounting
 * period than the accrual; the payment period must be open. A retried request
 * with the same idempotency key never double-pays.
 */
async function reimburseClaim(
  claim: ClaimRow,
  session: SessionPayload,
  opts: {
    reference?: string | null
    amount?: number | null
    payment_date?: string | null
    deposit_role?: "bank" | "cash"
    idempotency_key?: string | null
  },
): Promise<void> {
  const reimbursable = Number(claim.reimbursable_total) || 0
  if (reimbursable <= 0 || !claim.finance_expense_id) {
    // Nothing payable (e.g. an all-corporate-card claim): close without cash.
    await query(`UPDATE ${TABLE} SET status = 'Reimbursed', reimbursed_at = NOW(), reimbursement_reference = ? WHERE id = ?`, [
      opts.reference || null,
      claim.id,
    ])
    return
  }

  const plan = planReimbursement(reimbursable, Number(claim.reimbursed_amount) || 0, opts.amount ?? null)
  const paymentDate = String(opts.payment_date || new Date().toISOString().slice(0, 10)).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) throw new Error("payment_date must be YYYY-MM-DD.")

  const [exp] = (await query(`SELECT id FROM expenses WHERE expense_id = ? LIMIT 1`, [claim.finance_expense_id])) as any[]
  if (!exp) throw new Error(`Linked finance expense ${claim.finance_expense_id} not found.`)

  const payment = await recordExpensePayment({
    expense_pk: Number(exp.id),
    payment_type: "Payment",
    payment_date: paymentDate,
    amount: plan.amount,
    deposit_role: opts.deposit_role === "cash" ? "cash" : "bank",
    reference_no: opts.reference || null,
    narration: `Reimbursement of expense claim ${claim.claim_id}`,
    idempotency_key: opts.idempotency_key ? `claim:${claim.id}:${opts.idempotency_key}` : null,
    created_by: session.userId,
  })
  if ((payment as any).duplicate) return

  await query(
    `UPDATE ${TABLE} SET status = ?, reimbursed_amount = ?, reimbursed_at = NOW(), reimbursement_reference = ? WHERE id = ?`,
    [plan.status, plan.reimbursedAfter, opts.reference || (payment as any).payment_id || null, claim.id],
  )
}

/**
 * Phase 4 — project an approved claim into Finance → Expenses as an employee
 * "Reimbursement" expense for the out-of-pocket (reimbursable) total only, then
 * post the balanced accrual through the shared expense posting engine. The
 * corporate-card portion is intentionally excluded: it is already settled by
 * the company via the card and reconciled in Bank & Cash, not reimbursed.
 */
async function postClaimToFinance(
  claim: ClaimRow,
  session: SessionPayload,
): Promise<{ expenseId: string; voucherNo: string | null }> {
  const reimbursable = Number(claim.reimbursable_total) || 0
  if (reimbursable <= 0) {
    // Nothing to reimburse (e.g. an all-corporate-card claim). Approve without
    // a Finance posting so the ledger is never touched for a zero payable.
    return { expenseId: "", voucherNo: null }
  }

  const expenseDate = String(claim.claim_date || new Date().toISOString().slice(0, 10)).slice(0, 10)
  const merged: Record<string, any> = {
    expense_type: "Reimbursement",
    expense_date: expenseDate,
    description: claim.title || `Expense claim ${claim.claim_id}`,
    employee_id: claim.employee_id,
    employee_name: claim.employee_name,
    reference_number: claim.claim_id,
    taxable_amount: reimbursable,
    gst_applicable: 0,
    approval_status: "Approved",
    workflow_status: "Approved",
    payment_status: "Unpaid",
    financial_year: financialYearFor(expenseDate),
  }

  const augmented = await computeExpenseServerFields(merged, { isCreate: true })
  const expenseId = await nextExpenseId(expenseDate)
  const finalRow: Record<string, any> = {
    ...merged,
    ...augmented,
    expense_id: expenseId,
    approval_status: "Approved",
    workflow_status: "Approved",
    approved_by_id: session.userId,
    approved_at: new Date(),
    created_by: session.userId,
    submitted_at: new Date(),
  }

  // Only write columns that actually exist on the expenses table so a
  // schema-lagged install degrades gracefully instead of erroring.
  const cols = await tableColumns("expenses")
  const keys = Object.keys(finalRow).filter((k) => cols.has(k) && finalRow[k] !== undefined)
  const placeholders = keys.map(() => "?").join(",")
  await query(
    `INSERT INTO expenses (${keys.map((k) => `\`${k}\``).join(",")}) VALUES (${placeholders})`,
    keys.map((k) => finalRow[k]),
  )

  let voucherNo: string | null = null
  try {
    const result = await syncExpensePosting(expenseId, { createdBy: session.userId })
    voucherNo = (result as any)?.voucherNo ?? (result as any)?.voucher_no ?? null
  } catch (error) {
    console.log("[v0] claim finance posting failed:", (error as Error).message)
  }
  if (!voucherNo) {
    const rows = (await query(`SELECT voucher_no FROM expenses WHERE expense_id = ? LIMIT 1`, [expenseId])) as any[]
    voucherNo = rows[0]?.voucher_no ?? null
  }
  return { expenseId, voucherNo }
}
