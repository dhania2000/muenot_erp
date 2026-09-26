import "server-only"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { logFinanceEvent } from "@/lib/finance-audit"
import { num } from "@/lib/finance-calc"
import {
  evaluateSodApproval,
  evaluateBudget,
  evaluatePoChain,
  evaluateGrnChain,
  evaluateRfqAward,
  evaluateRequisitionCancellation,
  evaluatePoCancellation,
  derivePoFulfilmentStatus,
} from "@/lib/finance-procurement-rules"

/**
 * SPEC 136 — Procurement workflow (server side). Owns the on-demand schema for
 * the four procurement documents and the cross-record guards / side effects
 * that the config-driven CRUD engine (lib/finance-crud.ts) invokes for the
 * "purchase-requisition", "rfq", "purchase-orders" and "goods-receipt" modules.
 *
 * All control DECISIONS live in the pure lib/finance-procurement-rules.ts so
 * they are unit-testable without a database; this module only fetches the data
 * those decisions need and applies the resulting status propagation + audit.
 */

// ---------------------------------------------------------------------------
// Schema — mirrors ensureBudgetSchema: idempotent, created once per process.
// The same tables are also created by the SPEC-136 migration; both use
// CREATE TABLE IF NOT EXISTS so they are safe to run in either order.
// ---------------------------------------------------------------------------

let procurementSchemaEnsured = false

export async function ensureProcurementSchema(): Promise<void> {
  if (procurementSchemaEnsured) return

  await query(`CREATE TABLE IF NOT EXISTS procurement_requisitions (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    requisition_id       VARCHAR(30) NOT NULL,
    title                VARCHAR(255) DEFAULT NULL,
    request_date         DATE DEFAULT NULL,
    requested_by         VARCHAR(190) DEFAULT NULL,
    department           VARCHAR(190) DEFAULT NULL,
    priority             VARCHAR(20) DEFAULT NULL,
    required_by_date     DATE DEFAULT NULL,
    financial_year       VARCHAR(12) DEFAULT NULL,
    item_description      TEXT DEFAULT NULL,
    quantity             DECIMAL(16,3) NOT NULL DEFAULT 0,
    uom                  VARCHAR(30) DEFAULT NULL,
    estimated_unit_price DECIMAL(16,2) NOT NULL DEFAULT 0,
    estimated_amount     DECIMAL(16,2) NOT NULL DEFAULT 0,
    currency             VARCHAR(10) DEFAULT NULL,
    cost_center          VARCHAR(190) DEFAULT NULL,
    project_name         VARCHAR(190) DEFAULT NULL,
    budget_reference     VARCHAR(60) DEFAULT NULL,
    justification        TEXT DEFAULT NULL,
    approval_status      VARCHAR(20) NOT NULL DEFAULT 'Draft',
    approved_by          VARCHAR(190) DEFAULT NULL,
    approval_date        DATE DEFAULT NULL,
    requisition_status   VARCHAR(20) NOT NULL DEFAULT 'Open',
    notes                TEXT DEFAULT NULL,
    created_by           INT DEFAULT NULL,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pr_id (requisition_id),
    KEY idx_pr_status (approval_status),
    KEY idx_pr_stage (requisition_status),
    KEY idx_pr_fy (financial_year),
    KEY idx_pr_dept (department),
    KEY idx_pr_budget (budget_reference)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS procurement_rfqs (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    rfq_id               VARCHAR(30) NOT NULL,
    title                VARCHAR(255) DEFAULT NULL,
    requisition_id       VARCHAR(30) DEFAULT NULL,
    issue_date           DATE DEFAULT NULL,
    due_date             DATE DEFAULT NULL,
    item_description     TEXT DEFAULT NULL,
    quantity             DECIMAL(16,3) NOT NULL DEFAULT 0,
    uom                  VARCHAR(30) DEFAULT NULL,
    vendor_1_name        VARCHAR(190) DEFAULT NULL,
    vendor_1_id          VARCHAR(60) DEFAULT NULL,
    vendor_1_quote       DECIMAL(16,2) NOT NULL DEFAULT 0,
    vendor_2_name        VARCHAR(190) DEFAULT NULL,
    vendor_2_id          VARCHAR(60) DEFAULT NULL,
    vendor_2_quote       DECIMAL(16,2) NOT NULL DEFAULT 0,
    vendor_3_name        VARCHAR(190) DEFAULT NULL,
    vendor_3_id          VARCHAR(60) DEFAULT NULL,
    vendor_3_quote       DECIMAL(16,2) NOT NULL DEFAULT 0,
    selection_method     VARCHAR(30) DEFAULT NULL,
    selected_vendor_name VARCHAR(190) DEFAULT NULL,
    selected_vendor_id   VARCHAR(60) DEFAULT NULL,
    lowest_quote         DECIMAL(16,2) NOT NULL DEFAULT 0,
    highest_quote        DECIMAL(16,2) NOT NULL DEFAULT 0,
    awarded_amount       DECIMAL(16,2) NOT NULL DEFAULT 0,
    estimated_savings    DECIMAL(16,2) NOT NULL DEFAULT 0,
    quote_count          INT NOT NULL DEFAULT 0,
    status               VARCHAR(20) NOT NULL DEFAULT 'Draft',
    notes                TEXT DEFAULT NULL,
    created_by           INT DEFAULT NULL,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_rfq_id (rfq_id),
    KEY idx_rfq_status (status),
    KEY idx_rfq_req (requisition_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS procurement_purchase_orders (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    po_number            VARCHAR(30) NOT NULL,
    vendor_name          VARCHAR(190) DEFAULT NULL,
    vendor_id            VARCHAR(60) DEFAULT NULL,
    order_date           DATE DEFAULT NULL,
    expected_delivery_date DATE DEFAULT NULL,
    rfq_id               VARCHAR(30) DEFAULT NULL,
    requisition_id       VARCHAR(30) DEFAULT NULL,
    financial_year       VARCHAR(12) DEFAULT NULL,
    item_description     TEXT DEFAULT NULL,
    quantity             DECIMAL(16,3) NOT NULL DEFAULT 0,
    uom                  VARCHAR(30) DEFAULT NULL,
    unit_price           DECIMAL(16,2) NOT NULL DEFAULT 0,
    subtotal             DECIMAL(16,2) NOT NULL DEFAULT 0,
    discount_percent     DECIMAL(9,2) NOT NULL DEFAULT 0,
    discount_amount      DECIMAL(16,2) NOT NULL DEFAULT 0,
    taxable_amount       DECIMAL(16,2) NOT NULL DEFAULT 0,
    gst_rate             DECIMAL(9,2) NOT NULL DEFAULT 0,
    gst_amount           DECIMAL(16,2) NOT NULL DEFAULT 0,
    total_amount         DECIMAL(16,2) NOT NULL DEFAULT 0,
    currency             VARCHAR(10) DEFAULT NULL,
    payment_terms        VARCHAR(190) DEFAULT NULL,
    delivery_terms       VARCHAR(190) DEFAULT NULL,
    approval_status      VARCHAR(20) NOT NULL DEFAULT 'Draft',
    approved_by          VARCHAR(190) DEFAULT NULL,
    approval_date        DATE DEFAULT NULL,
    status               VARCHAR(20) NOT NULL DEFAULT 'Draft',
    notes                TEXT DEFAULT NULL,
    created_by           INT DEFAULT NULL,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_po_number (po_number),
    KEY idx_po_status (status),
    KEY idx_po_approval (approval_status),
    KEY idx_po_vendor (vendor_name),
    KEY idx_po_req (requisition_id),
    KEY idx_po_rfq (rfq_id),
    KEY idx_po_fy (financial_year)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS procurement_goods_receipts (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    grn_id               VARCHAR(30) NOT NULL,
    po_number            VARCHAR(30) DEFAULT NULL,
    vendor_name          VARCHAR(190) DEFAULT NULL,
    receipt_date         DATE DEFAULT NULL,
    item_description     TEXT DEFAULT NULL,
    uom                  VARCHAR(30) DEFAULT NULL,
    ordered_quantity     DECIMAL(16,3) NOT NULL DEFAULT 0,
    received_quantity    DECIMAL(16,3) NOT NULL DEFAULT 0,
    accepted_quantity    DECIMAL(16,3) NOT NULL DEFAULT 0,
    rejected_quantity    DECIMAL(16,3) NOT NULL DEFAULT 0,
    pending_quantity     DECIMAL(16,3) NOT NULL DEFAULT 0,
    unit_price           DECIMAL(16,2) NOT NULL DEFAULT 0,
    received_value       DECIMAL(16,2) NOT NULL DEFAULT 0,
    quality_status       VARCHAR(20) DEFAULT NULL,
    receipt_status       VARCHAR(20) NOT NULL DEFAULT 'Pending',
    inspection_notes     TEXT DEFAULT NULL,
    created_by           INT DEFAULT NULL,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_grn_id (grn_id),
    KEY idx_grn_po (po_number),
    KEY idx_grn_status (receipt_status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  procurementSchemaEnsured = true
}

// ---------------------------------------------------------------------------
// Small typed lookups used by the guards / side effects.
// ---------------------------------------------------------------------------

async function actorUserId(): Promise<number | null> {
  const session = await getSession()
  return session ? Number(session.userId) : null
}

async function actorName(): Promise<string | null> {
  const session = await getSession()
  return session?.name ?? null
}

async function findRequisition(ref: string) {
  if (!ref) return null
  const rows = (await query(
    `SELECT requisition_id, approval_status, requisition_status, estimated_amount, budget_reference, department, financial_year
       FROM procurement_requisitions WHERE requisition_id = ? LIMIT 1`,
    [ref],
  )) as any[]
  return rows[0] ?? null
}

async function findRfq(ref: string) {
  if (!ref) return null
  const rows = (await query(
    `SELECT rfq_id, status FROM procurement_rfqs WHERE rfq_id = ? LIMIT 1`,
    [ref],
  )) as any[]
  return rows[0] ?? null
}

async function findPo(ref: string) {
  if (!ref) return null
  const rows = (await query(
    `SELECT po_number, approval_status, status, quantity, requisition_id FROM procurement_purchase_orders WHERE po_number = ? LIMIT 1`,
    [ref],
  )) as any[]
  return rows[0] ?? null
}

/** Value already committed by OTHER approved procurement docs against a budget. */
async function committedAgainstBudget(
  budgetRef: string,
  opts: { excludeRequisition?: string; excludePo?: string },
): Promise<number> {
  if (!budgetRef) return 0
  const reqRows = (await query(
    `SELECT COALESCE(SUM(estimated_amount),0) AS s FROM procurement_requisitions
       WHERE budget_reference = ? AND approval_status = 'Approved' AND requisition_id <> ?`,
    [budgetRef, opts.excludeRequisition ?? "__none__"],
  )) as any[]
  return num(reqRows[0]?.s)
}

async function findBudget(budgetRef: string, department: string, fy: string) {
  // Prefer an explicit budget reference (budget_id); fall back to the
  // department + financial-year budget when no explicit reference is given.
  if (budgetRef) {
    const rows = (await query(
      `SELECT budget_id, budgeted_amount, actual_amount FROM finance_budgets WHERE budget_id = ? LIMIT 1`,
      [budgetRef],
    )) as any[]
    if (rows[0]) return rows[0]
  }
  if (department && fy) {
    const rows = (await query(
      `SELECT budget_id, budgeted_amount, actual_amount FROM finance_budgets
         WHERE department = ? AND financial_year = ? AND approval_status = 'Approved'
         ORDER BY budgeted_amount DESC LIMIT 1`,
      [department, fy],
    )) as any[]
    if (rows[0]) return rows[0]
  }
  return null
}

async function budgetTableExists(): Promise<boolean> {
  const rows = (await query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'finance_budgets'`,
  )) as any[]
  return num(rows[0]?.n) > 0
}

type GuardCtx = { isCreate: boolean; existing: Record<string, any> | null }

// ---------------------------------------------------------------------------
// Guards — wired into finance-crud's ASYNC_GUARDS map. Return string => reject.
// ---------------------------------------------------------------------------

export async function guardRequisitionWrite(merged: Record<string, any>, ctx: GuardCtx): Promise<string | null> {
  const prevStatus = ctx.existing?.approval_status ?? null
  const nextStatus = merged.approval_status ?? prevStatus

  // Segregation of duties on approval.
  const sod = evaluateSodApproval({
    actorUserId: await actorUserId(),
    creatorUserId: ctx.existing?.created_by ?? merged.created_by ?? null,
    prevStatus,
    nextStatus,
    documentLabel: "requisition",
  })
  if (sod) return sod

  // Budget limit — enforced at the approval control point.
  if (String(nextStatus) === "Approved" && String(prevStatus) !== "Approved") {
    if (await budgetTableExists()) {
      const budget = await findBudget(
        String(merged.budget_reference ?? "").trim(),
        String(merged.department ?? "").trim(),
        String(merged.financial_year ?? "").trim(),
      )
      const committed = budget
        ? await committedAgainstBudget(String(budget.budget_id), {
            excludeRequisition: String(merged.requisition_id ?? ctx.existing?.requisition_id ?? ""),
          })
        : 0
      const decision = evaluateBudget({
        amount: merged.estimated_amount,
        budgetedAmount: budget?.budgeted_amount,
        actualAmount: budget?.actual_amount,
        committedAmount: committed,
        budgetFound: !!budget,
      })
      if (!decision.ok) return decision.message
    }
  }

  // Cancellation rule.
  if (String(merged.requisition_status) === "Cancelled") {
    const reqId = String(merged.requisition_id ?? ctx.existing?.requisition_id ?? "")
    if (reqId) {
      const rows = (await query(
        `SELECT COUNT(*) AS n FROM procurement_purchase_orders WHERE requisition_id = ? AND status <> 'Cancelled'`,
        [reqId],
      )) as any[]
      const err = evaluateRequisitionCancellation("Cancelled", { linkedPoCount: num(rows[0]?.n) })
      if (err) return err
    }
  }
  return null
}

export async function guardRfqWrite(merged: Record<string, any>, ctx: GuardCtx): Promise<string | null> {
  const err = evaluateRfqAward(merged.status, merged.quote_count)
  if (err) return err
  const reqRef = String(merged.requisition_id ?? "").trim()
  if (reqRef && !(await findRequisition(reqRef))) {
    return `RFQ references requisition ${reqRef}, which does not exist.`
  }
  return null
}

export async function guardPoWrite(merged: Record<string, any>, ctx: GuardCtx): Promise<string | null> {
  const prevStatus = ctx.existing?.approval_status ?? null
  const nextStatus = merged.approval_status ?? prevStatus

  // Segregation of duties on approval.
  const sod = evaluateSodApproval({
    actorUserId: await actorUserId(),
    creatorUserId: ctx.existing?.created_by ?? merged.created_by ?? null,
    prevStatus,
    nextStatus,
    documentLabel: "purchase order",
  })
  if (sod) return sod

  // Chain linking — requisition/RFQ must have cleared their gate.
  const reqRef = String(merged.requisition_id ?? "").trim()
  const rfqRef = String(merged.rfq_id ?? "").trim()
  const chain = evaluatePoChain({
    requisitionRef: reqRef,
    requisition: reqRef ? await findRequisition(reqRef) : null,
    rfqRef,
    rfq: rfqRef ? await findRfq(rfqRef) : null,
  })
  if (chain) return chain

  // Budget limit at approval.
  if (String(nextStatus) === "Approved" && String(prevStatus) !== "Approved") {
    if (await budgetTableExists()) {
      const requisition = reqRef ? await findRequisition(reqRef) : null
      const budgetRef = String(requisition?.budget_reference ?? "").trim()
      const budget = await findBudget(
        budgetRef,
        String(merged.department ?? requisition?.department ?? "").trim(),
        String(merged.financial_year ?? "").trim(),
      )
      const committed = budget
        ? await committedAgainstBudget(String(budget.budget_id), {})
        : 0
      const decision = evaluateBudget({
        amount: merged.total_amount,
        budgetedAmount: budget?.budgeted_amount,
        actualAmount: budget?.actual_amount,
        committedAmount: committed,
        budgetFound: !!budget,
      })
      if (!decision.ok) return decision.message
    }
  }

  // Cancellation rule.
  if (String(merged.status) === "Cancelled") {
    const poRef = String(merged.po_number ?? ctx.existing?.po_number ?? "")
    if (poRef) {
      const grnRows = (await query(
        `SELECT COUNT(*) AS n FROM procurement_goods_receipts WHERE po_number = ?`,
        [poRef],
      )) as any[]
      const billRows = await countBillsForPo(poRef)
      const err = evaluatePoCancellation("Cancelled", {
        grnCount: num(grnRows[0]?.n),
        billCount: billRows,
      })
      if (err) return err
    }
  }
  return null
}

export async function guardGrnWrite(merged: Record<string, any>, ctx: GuardCtx): Promise<string | null> {
  const poRef = String(merged.po_number ?? "").trim()
  const err = evaluateGrnChain({
    poRef,
    po: poRef ? await findPo(poRef) : null,
    receivedQuantity: merged.received_quantity,
  })
  if (err) return err
  return null
}

/** Count vendor bills linked to a PO — tolerant of the table not existing yet. */
async function countBillsForPo(poRef: string): Promise<number> {
  try {
    const rows = (await query(
      `SELECT COUNT(*) AS n FROM purchase_bills WHERE po_number = ?`,
      [poRef],
    )) as any[]
    return num(rows[0]?.n)
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// After-write side effects — status propagation across the chain + audit.
// Each transition is only logged when it actually changes something, so a
// re-save (idempotent replay) does not create duplicate audit rows.
// ---------------------------------------------------------------------------

type AfterCtx = {
  finalRow: Record<string, any>
  isCreate: boolean
  existing: Record<string, any> | null
  userId: number
}

export async function afterRequisitionWrite(ctx: AfterCtx): Promise<void> {
  const row = ctx.finalRow
  const reqId = String(row.requisition_id ?? "")
  const prev = ctx.existing?.approval_status ?? null
  const next = row.approval_status ?? null
  const name = (await actorName()) || null

  if (ctx.isCreate) {
    await logFinanceEvent({
      entityType: "procurement_requisition",
      entityPk: row.id != null ? Number(row.id) : null,
      entityRef: reqId,
      type: "created",
      summary: `Requisition ${reqId} created`,
      amount: num(row.estimated_amount),
      actorId: ctx.userId,
      actorName: name,
    })
    return
  }

  if (String(prev) !== String(next)) {
    // Stamp the approver + date authoritatively on approval.
    if (String(next) === "Approved") {
      await query(
        `UPDATE procurement_requisitions SET approved_by = COALESCE(approved_by, ?), approval_date = COALESCE(approval_date, CURDATE()) WHERE requisition_id = ?`,
        [name, reqId],
      )
    }
    await logFinanceEvent({
      entityType: "procurement_requisition",
      entityPk: row.id != null ? Number(row.id) : null,
      entityRef: reqId,
      type: next === "Approved" ? "approved" : next === "Rejected" ? "rejected" : "updated",
      summary: `Requisition ${reqId} status ${prev || "—"} → ${next || "—"}`,
      detail: { from: prev, to: next },
      amount: num(row.estimated_amount),
      actorId: ctx.userId,
      actorName: name,
    })
  }
}

export async function afterRfqWrite(ctx: AfterCtx): Promise<void> {
  const row = ctx.finalRow
  const rfqId = String(row.rfq_id ?? "")
  const prev = ctx.existing?.status ?? null
  const next = row.status ?? null
  const name = (await actorName()) || null

  // When an RFQ is awarded, advance its requisition to the "In RFQ" stage.
  if (String(next) === "Awarded" && String(prev) !== "Awarded") {
    const reqRef = String(row.requisition_id ?? "").trim()
    if (reqRef) {
      await query(
        `UPDATE procurement_requisitions SET requisition_status = 'In RFQ'
           WHERE requisition_id = ? AND requisition_status IN ('Open')`,
        [reqRef],
      )
    }
    await logFinanceEvent({
      entityType: "procurement_rfq",
      entityPk: row.id != null ? Number(row.id) : null,
      entityRef: rfqId,
      type: "approved",
      summary: `RFQ ${rfqId} awarded to ${row.selected_vendor_name || "vendor"}`,
      amount: num(row.awarded_amount),
      actorId: ctx.userId,
      actorName: name,
    })
  } else if (ctx.isCreate) {
    await logFinanceEvent({
      entityType: "procurement_rfq",
      entityPk: row.id != null ? Number(row.id) : null,
      entityRef: rfqId,
      type: "created",
      summary: `RFQ ${rfqId} created`,
      actorId: ctx.userId,
      actorName: name,
    })
  }
}

export async function afterPoWrite(ctx: AfterCtx): Promise<void> {
  const row = ctx.finalRow
  const poNumber = String(row.po_number ?? "")
  const prev = ctx.existing?.approval_status ?? null
  const next = row.approval_status ?? null
  const name = (await actorName()) || null

  if (ctx.isCreate) {
    await logFinanceEvent({
      entityType: "procurement_po",
      entityPk: row.id != null ? Number(row.id) : null,
      entityRef: poNumber,
      type: "created",
      summary: `Purchase order ${poNumber} created`,
      amount: num(row.total_amount),
      actorId: ctx.userId,
      actorName: name,
    })
  }

  if (String(prev) !== String(next) && String(next) === "Approved") {
    await query(
      `UPDATE procurement_purchase_orders SET approved_by = COALESCE(approved_by, ?), approval_date = COALESCE(approval_date, CURDATE()) WHERE po_number = ?`,
      [name, poNumber],
    )
    // Advance the requisition to "In PO".
    const reqRef = String(row.requisition_id ?? "").trim()
    if (reqRef) {
      await query(
        `UPDATE procurement_requisitions SET requisition_status = 'In PO'
           WHERE requisition_id = ? AND requisition_status IN ('Open','In RFQ')`,
        [reqRef],
      )
    }
    await logFinanceEvent({
      entityType: "procurement_po",
      entityPk: row.id != null ? Number(row.id) : null,
      entityRef: poNumber,
      type: "approved",
      summary: `Purchase order ${poNumber} approved`,
      amount: num(row.total_amount),
      actorId: ctx.userId,
      actorName: name,
    })
  }

  if (String(prev) !== String(next) && String(next) === "Rejected") {
    await logFinanceEvent({
      entityType: "procurement_po",
      entityPk: row.id != null ? Number(row.id) : null,
      entityRef: poNumber,
      type: "rejected",
      summary: `Purchase order ${poNumber} rejected`,
      actorId: ctx.userId,
      actorName: name,
    })
  }
}

export async function afterGrnWrite(ctx: AfterCtx): Promise<void> {
  const row = ctx.finalRow
  const grnId = String(row.grn_id ?? "")
  const poNumber = String(row.po_number ?? "").trim()
  const name = (await actorName()) || null

  await logFinanceEvent({
    entityType: "procurement_grn",
    entityPk: row.id != null ? Number(row.id) : null,
    entityRef: grnId,
    type: ctx.isCreate ? "created" : "updated",
    summary: `Goods receipt ${grnId} (${row.receipt_status || "Pending"}) for PO ${poNumber || "—"}`,
    amount: num(row.received_value),
    actorId: ctx.userId,
    actorName: name,
  })

  if (!poNumber) return
  const po = await findPo(poNumber)
  if (!po) return

  // Recompute PO fulfilment from the cumulative received quantity across ALL
  // receipts for this PO (partial receipts accumulate to Complete).
  const sumRows = (await query(
    `SELECT COALESCE(SUM(received_quantity),0) AS total FROM procurement_goods_receipts WHERE po_number = ?`,
    [poNumber],
  )) as any[]
  const totalReceived = num(sumRows[0]?.total)
  const newStatus = derivePoFulfilmentStatus(po.quantity, totalReceived, po.status)

  if (String(newStatus) !== String(po.status)) {
    await query(`UPDATE procurement_purchase_orders SET status = ? WHERE po_number = ?`, [newStatus, poNumber])
    await logFinanceEvent({
      entityType: "procurement_po",
      entityRef: poNumber,
      type: "updated",
      summary: `Purchase order ${poNumber} fulfilment ${po.status || "—"} → ${newStatus}`,
      detail: { from: po.status, to: newStatus, totalReceived },
      actorId: ctx.userId,
      actorName: name,
    })
    // Fully received PO fulfils its requisition.
    if (String(newStatus) === "Received" && po.requisition_id) {
      await query(
        `UPDATE procurement_requisitions SET requisition_status = 'Fulfilled'
           WHERE requisition_id = ? AND requisition_status <> 'Cancelled'`,
        [String(po.requisition_id)],
      )
    }
  }
}
