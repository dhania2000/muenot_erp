import "server-only"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { getTenantId } from "@/lib/api-auth"
import { logFinanceEvent } from "@/lib/finance-audit"
import { num, round2 } from "@/lib/finance-calc"
import { deriveGrnFields } from "@/lib/finance-procurement-calc"
import {
  evaluateSodApproval,
  evaluateBudget,
  evaluatePoChain,
  evaluateGrnChain,
  evaluateRfqAward,
  evaluateRfqSelection,
  evaluateRfqCancellation,
  evaluateRequisitionCancellation,
  evaluatePoCancellation,
  evaluateApprovalTransition,
  evaluateApprovedImmutability,
  evaluatePoAgainstUpstream,
  evaluateGrnQuantities,
  evaluateGrnSod,
  evaluateBillAgainstPo,
  evaluateBillPayment,
  evaluateProcurementDelete,
  derivePoFulfilmentStatus,
} from "@/lib/finance-procurement-rules"
import { evaluateBillPaymentHold } from "@/lib/finance-three-way-match-server"

/**
 * SPEC 136 / Spec36 (#200) — Procurement workflow (server side).
 *
 * Owns the on-demand schema for the four procurement documents and the
 * cross-record guards / side effects the config-driven CRUD engine
 * (lib/finance-crud.ts) invokes for "purchase-requisition", "rfq",
 * "purchase-orders", "goods-receipt" and the procurement link on
 * "purchase-bills". Every read and write here is bounded to the acting tenant.
 * All control DECISIONS live in the pure lib/finance-procurement-rules.ts.
 */

export const PROCUREMENT_TABLES = {
  "purchase-requisition": { table: "procurement_requisitions", idColumn: "requisition_id" },
  rfq: { table: "procurement_rfqs", idColumn: "rfq_id" },
  "purchase-orders": { table: "procurement_purchase_orders", idColumn: "po_number" },
  "goods-receipt": { table: "procurement_goods_receipts", idColumn: "grn_id" },
} as const

export class ProcurementTenantError extends Error {
  constructor() {
    super("No tenant context for this procurement request.")
  }
}

/** The acting tenant; procurement never runs unscoped. */
export async function requireProcurementTenant(): Promise<number> {
  const tenantId = await getTenantId()
  if (tenantId == null) throw new ProcurementTenantError()
  return Number(tenantId)
}

// ---------------------------------------------------------------------------
// Schema — idempotent, once per process. New installs get tenant-scoped
// unique keys; installs created by the earlier SPEC-136 DDL are self-healed
// (tenant_id + idempotency columns added, global unique keys swapped for
// per-tenant ones). database/migrations/2027-01-29-spec36-procurement-workflow.sql
// performs the same steps for managed deploys.
// ---------------------------------------------------------------------------

let procurementSchemaEnsured = false

const COMMON_COLUMNS = `
    tenant_id            INT DEFAULT NULL,
    idempotency_key      VARCHAR(100) DEFAULT NULL,
    created_by           INT DEFAULT NULL,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,`

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
    item_description     TEXT DEFAULT NULL,
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
    approved_by_user_id  INT DEFAULT NULL,
    approval_date        DATE DEFAULT NULL,
    requisition_status   VARCHAR(20) NOT NULL DEFAULT 'Open',
    notes                TEXT DEFAULT NULL,${COMMON_COLUMNS}
    UNIQUE KEY uq_pr_tenant_id (tenant_id, requisition_id),
    UNIQUE KEY uq_pr_idem (tenant_id, idempotency_key),
    KEY idx_pr_status (approval_status),
    KEY idx_pr_stage (requisition_status),
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
    awarded_by_user_id   INT DEFAULT NULL,
    notes                TEXT DEFAULT NULL,${COMMON_COLUMNS}
    UNIQUE KEY uq_rfq_tenant_id (tenant_id, rfq_id),
    UNIQUE KEY uq_rfq_idem (tenant_id, idempotency_key),
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
    approved_by_user_id  INT DEFAULT NULL,
    approval_date        DATE DEFAULT NULL,
    status               VARCHAR(20) NOT NULL DEFAULT 'Draft',
    notes                TEXT DEFAULT NULL,${COMMON_COLUMNS}
    UNIQUE KEY uq_po_tenant_number (tenant_id, po_number),
    UNIQUE KEY uq_po_idem (tenant_id, idempotency_key),
    KEY idx_po_status (status),
    KEY idx_po_approval (approval_status),
    KEY idx_po_req (requisition_id),
    KEY idx_po_rfq (rfq_id)
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
    inspection_notes     TEXT DEFAULT NULL,${COMMON_COLUMNS}
    UNIQUE KEY uq_grn_tenant_id (tenant_id, grn_id),
    UNIQUE KEY uq_grn_idem (tenant_id, idempotency_key),
    KEY idx_grn_po (po_number),
    KEY idx_grn_status (receipt_status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await healLegacyProcurementSchema()
  procurementSchemaEnsured = true
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = (await query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  )) as any[]
  return num(rows[0]?.n) > 0
}

async function indexExists(table: string, index: string): Promise<boolean> {
  const rows = (await query(
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index],
  )) as any[]
  return num(rows[0]?.n) > 0
}

/** Upgrades tables created by the pre-tenant SPEC-136 DDL. Safe to re-run. */
async function healLegacyProcurementSchema(): Promise<void> {
  const plan: Array<{ table: string; idColumn: string; legacyKey: string; tenantKey: string; idemKey: string; extra: string[] }> = [
    { table: "procurement_requisitions", idColumn: "requisition_id", legacyKey: "uq_pr_id", tenantKey: "uq_pr_tenant_id", idemKey: "uq_pr_idem", extra: ["approved_by_user_id INT DEFAULT NULL"] },
    { table: "procurement_rfqs", idColumn: "rfq_id", legacyKey: "uq_rfq_id", tenantKey: "uq_rfq_tenant_id", idemKey: "uq_rfq_idem", extra: ["awarded_by_user_id INT DEFAULT NULL"] },
    { table: "procurement_purchase_orders", idColumn: "po_number", legacyKey: "uq_po_number", tenantKey: "uq_po_tenant_number", idemKey: "uq_po_idem", extra: ["approved_by_user_id INT DEFAULT NULL"] },
    { table: "procurement_goods_receipts", idColumn: "grn_id", legacyKey: "uq_grn_id", tenantKey: "uq_grn_tenant_id", idemKey: "uq_grn_idem", extra: [] },
  ]
  for (const t of plan) {
    const columns = ["tenant_id INT DEFAULT NULL", "idempotency_key VARCHAR(100) DEFAULT NULL", ...t.extra]
    for (const ddl of columns) {
      const name = ddl.split(" ")[0]
      if (!(await columnExists(t.table, name))) await query(`ALTER TABLE ${t.table} ADD COLUMN ${ddl}`)
    }
    if (!(await indexExists(t.table, t.tenantKey))) {
      await query(`ALTER TABLE ${t.table} ADD UNIQUE KEY ${t.tenantKey} (tenant_id, ${t.idColumn})`)
    }
    if (await indexExists(t.table, t.legacyKey)) await query(`ALTER TABLE ${t.table} DROP INDEX ${t.legacyKey}`)
    if (!(await indexExists(t.table, t.idemKey))) {
      await query(`ALTER TABLE ${t.table} ADD UNIQUE KEY ${t.idemKey} (tenant_id, idempotency_key)`)
    }
  }
}

// ---------------------------------------------------------------------------
// Idempotency — a retried create (same Idempotency-Key) returns the document
// already created instead of minting a second number.
// ---------------------------------------------------------------------------

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/

/** Returns the normalized key, null when absent, or throws on a malformed key. */
export function normalizeIdempotencyKey(raw: unknown): string | null {
  if (raw == null) return null
  const key = String(raw).trim()
  if (!key) return null
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new Error("Idempotency-Key must be 8–100 characters of letters, digits, '.', '_', ':' or '-'.")
  }
  return key
}

export async function findIdempotentReplay(
  moduleKey: keyof typeof PROCUREMENT_TABLES,
  tenantId: number,
  key: string,
): Promise<string | null> {
  const { table, idColumn } = PROCUREMENT_TABLES[moduleKey]
  const rows = (await query(
    `SELECT ${idColumn} AS ref FROM ${table} WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
    [tenantId, key],
  )) as any[]
  return rows[0]?.ref ? String(rows[0].ref) : null
}

export function isDuplicateKeyError(error: unknown): boolean {
  const e = error as { code?: string; errno?: number } | null
  return !!e && (e.code === "ER_DUP_ENTRY" || e.errno === 1062)
}

// ---------------------------------------------------------------------------
// Tenant-scoped lookups.
// ---------------------------------------------------------------------------

async function actor(): Promise<{ id: number | null; name: string | null }> {
  const session = await getSession()
  return { id: session ? Number(session.userId) : null, name: session?.name ?? null }
}

async function findRequisition(tenantId: number, ref: string) {
  if (!ref) return null
  const rows = (await query(
    `SELECT requisition_id, approval_status, requisition_status, quantity, estimated_amount, budget_reference, department, financial_year, created_by
       FROM procurement_requisitions WHERE tenant_id = ? AND requisition_id = ? LIMIT 1`,
    [tenantId, ref],
  )) as any[]
  return rows[0] ?? null
}

async function findRfq(tenantId: number, ref: string) {
  if (!ref) return null
  const rows = (await query(
    `SELECT rfq_id, status, requisition_id, selected_vendor_id, selected_vendor_name, awarded_amount
       FROM procurement_rfqs WHERE tenant_id = ? AND rfq_id = ? LIMIT 1`,
    [tenantId, ref],
  )) as any[]
  return rows[0] ?? null
}

async function findPo(tenantId: number, ref: string) {
  if (!ref) return null
  const rows = (await query(
    `SELECT po_number, approval_status, status, quantity, unit_price, discount_percent, gst_rate, vendor_id, vendor_name,
            item_description, uom, requisition_id, approved_by_user_id, created_by
       FROM procurement_purchase_orders WHERE tenant_id = ? AND po_number = ? LIMIT 1`,
    [tenantId, ref],
  )) as any[]
  return rows[0] ?? null
}

async function countWhere(sql: string, args: unknown[]): Promise<number> {
  const rows = (await query(sql, args)) as any[]
  return num(rows[0]?.n)
}

/** Vendor bills linked to a PO — tolerant of the table not existing yet. */
async function countBillsForPo(poRef: string): Promise<number> {
  try {
    return await countWhere(`SELECT COUNT(*) AS n FROM purchase_bills WHERE po_number = ?`, [poRef])
  } catch {
    return 0
  }
}

/** Unit price after the PO's discount — what a receipt is valued (and billed) at. */
function netUnitPrice(po: Record<string, any>): number {
  const discount = Math.min(100, Math.max(0, num(po.discount_percent)))
  return round2(num(po.unit_price) * (1 - discount / 100))
}

async function receivedOnOtherGrns(tenantId: number, poRef: string, excludeGrn: string): Promise<number> {
  const rows = (await query(
    `SELECT COALESCE(SUM(received_quantity),0) AS s FROM procurement_goods_receipts
       WHERE tenant_id = ? AND po_number = ? AND grn_id <> ?`,
    [tenantId, poRef, excludeGrn || "__none__"],
  )) as any[]
  return num(rows[0]?.s)
}

// ---------------------------------------------------------------------------
// Budget — remaining = budgeted − actual − committed. Committed counts approved
// requisitions not yet converted to an approved PO, plus approved live POs, so
// converting a requisition into a PO never double-counts the commitment.
// ---------------------------------------------------------------------------

async function budgetTableExists(): Promise<boolean> {
  return (
    (await countWhere(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'finance_budgets'`,
      [],
    )) > 0
  )
}

async function findBudget(budgetRef: string, department: string, fy: string) {
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

async function committedAgainstBudget(
  tenantId: number,
  budgetRef: string,
  opts: { excludeRequisition?: string; excludePo?: string },
): Promise<number> {
  if (!budgetRef) return 0
  const reqRows = (await query(
    `SELECT COALESCE(SUM(r.estimated_amount),0) AS s FROM procurement_requisitions r
       WHERE r.tenant_id = ? AND r.budget_reference = ? AND r.approval_status = 'Approved'
         AND r.requisition_status <> 'Cancelled' AND r.requisition_id <> ?
         AND NOT EXISTS (
           SELECT 1 FROM procurement_purchase_orders p
            WHERE p.tenant_id = r.tenant_id AND p.requisition_id = r.requisition_id
              AND p.approval_status = 'Approved' AND p.status <> 'Cancelled'
         )`,
    [tenantId, budgetRef, opts.excludeRequisition || "__none__"],
  )) as any[]
  const poRows = (await query(
    `SELECT COALESCE(SUM(p.total_amount),0) AS s FROM procurement_purchase_orders p
       JOIN procurement_requisitions r ON r.tenant_id = p.tenant_id AND r.requisition_id = p.requisition_id
       WHERE p.tenant_id = ? AND r.budget_reference = ? AND p.approval_status = 'Approved'
         AND p.status <> 'Cancelled' AND p.po_number <> ?`,
    [tenantId, budgetRef, opts.excludePo || "__none__"],
  )) as any[]
  return round2(num(reqRows[0]?.s) + num(poRows[0]?.s))
}

async function checkBudget(
  tenantId: number,
  amount: unknown,
  lookup: { budgetRef: string; department: string; fy: string },
  exclude: { excludeRequisition?: string; excludePo?: string },
): Promise<string | null> {
  if (!(await budgetTableExists())) return null
  const budget = await findBudget(lookup.budgetRef, lookup.department, lookup.fy)
  const committed = budget ? await committedAgainstBudget(tenantId, String(budget.budget_id), exclude) : 0
  const decision = evaluateBudget({
    amount,
    budgetedAmount: budget?.budgeted_amount,
    actualAmount: budget?.actual_amount,
    committedAmount: committed,
    budgetFound: !!budget,
  })
  return decision.ok ? null : decision.message
}

// ---------------------------------------------------------------------------
// Guards — wired into finance-crud's ASYNC_GUARDS. Return string => reject 400.
// ---------------------------------------------------------------------------

export type GuardCtx = {
  isCreate: boolean
  existing: Record<string, any> | null
  body?: Record<string, any>
}

const s = (v: unknown) => String(v ?? "").trim()

const REQUISITION_LOCKED = ["quantity", "estimated_unit_price", "estimated_amount", "budget_reference", "department", "item_description"] as const
const PO_LOCKED = ["quantity", "unit_price", "discount_percent", "gst_rate", "vendor_id", "vendor_name", "requisition_id", "rfq_id"] as const
const RFQ_LOCKED = ["selected_vendor_id", "selected_vendor_name", "awarded_amount", "vendor_1_quote", "vendor_2_quote", "vendor_3_quote", "requisition_id"] as const

export async function guardRequisitionWrite(merged: Record<string, any>, ctx: GuardCtx): Promise<string | null> {
  const tenantId = await requireProcurementTenant()
  const who = await actor()
  const prevStatus = ctx.existing?.approval_status ?? null
  const nextStatus = merged.approval_status ?? prevStatus ?? "Draft"

  if (num(merged.quantity) <= 0) return "Requisition quantity must be greater than zero."
  if (num(merged.estimated_unit_price) < 0 || num(merged.estimated_amount) < 0) return "Estimated amounts cannot be negative."

  const transition = evaluateApprovalTransition(prevStatus, nextStatus, { isCreate: ctx.isCreate, documentLabel: "requisition" })
  if (transition) return transition

  const locked = evaluateApprovedImmutability(ctx.existing, ctx.body ?? {}, REQUISITION_LOCKED, "requisition")
  if (locked) return locked

  const sod = evaluateSodApproval({
    actorUserId: who.id,
    creatorUserId: ctx.existing?.created_by ?? null,
    prevStatus,
    nextStatus,
    documentLabel: "requisition",
  })
  if (sod) return sod

  if (s(nextStatus) === "Approved" && s(prevStatus) !== "Approved") {
    const budgetErr = await checkBudget(
      tenantId,
      merged.estimated_amount,
      { budgetRef: s(merged.budget_reference), department: s(merged.department), fy: s(merged.financial_year) },
      { excludeRequisition: s(merged.requisition_id ?? ctx.existing?.requisition_id) },
    )
    if (budgetErr) return budgetErr
  }

  const prevStage = s(ctx.existing?.requisition_status)
  const nextStage = s(merged.requisition_status)
  if (nextStage === "Cancelled" && prevStage !== "Cancelled") {
    const reqId = s(merged.requisition_id ?? ctx.existing?.requisition_id)
    const linked = reqId
      ? await countWhere(
          `SELECT COUNT(*) AS n FROM procurement_purchase_orders WHERE tenant_id = ? AND requisition_id = ? AND status <> 'Cancelled'`,
          [tenantId, reqId],
        )
      : 0
    const err = evaluateRequisitionCancellation("Cancelled", { linkedPoCount: linked })
    if (err) return err
  }
  if (prevStage === "Cancelled" && nextStage !== "Cancelled") {
    return "A cancelled requisition cannot be reopened. Raise a new requisition instead."
  }
  return null
}

export async function guardRfqWrite(merged: Record<string, any>, ctx: GuardCtx): Promise<string | null> {
  const tenantId = await requireProcurementTenant()
  const who = await actor()
  const prev = s(ctx.existing?.status)
  const next = s(merged.status) || "Draft"

  if (ctx.isCreate && (next === "Awarded" || next === "Cancelled")) {
    return `A new RFQ must start as Draft or Issued; it cannot be created already ${next}.`
  }
  if (prev === "Cancelled" && next !== "Cancelled") return "A cancelled RFQ cannot be reopened."
  if (prev === "Awarded" && next !== "Awarded" && next !== "Cancelled") {
    return "An awarded RFQ can only be cancelled, not moved back to an earlier stage."
  }
  if (prev === "Awarded") {
    const locked = evaluateApprovedImmutability({ ...ctx.existing, approval_status: "Approved" }, ctx.body ?? {}, RFQ_LOCKED, "RFQ award")
    if (locked) return locked
  }

  const awardErr = evaluateRfqAward(next, merged.quote_count) ?? evaluateRfqSelection(merged)
  if (awardErr) return awardErr

  // Awarding is the RFQ's approval event — the creator may not award their own RFQ.
  const sod = evaluateSodApproval({
    actorUserId: who.id,
    creatorUserId: ctx.existing?.created_by ?? null,
    prevStatus: prev === "Awarded" ? "Approved" : prev,
    nextStatus: next === "Awarded" ? "Approved" : next,
    documentLabel: "RFQ",
  })
  if (sod) return sod

  const reqRef = s(merged.requisition_id)
  if (reqRef) {
    const requisition = await findRequisition(tenantId, reqRef)
    if (!requisition) return `RFQ references requisition ${reqRef}, which does not exist.`
    if (s(requisition.approval_status) !== "Approved") {
      return `RFQ cannot be issued: requisition ${reqRef} is not approved.`
    }
    if (s(requisition.requisition_status) === "Cancelled") return `RFQ cannot reference cancelled requisition ${reqRef}.`
  }

  if (next === "Cancelled" && prev !== "Cancelled") {
    const rfqId = s(merged.rfq_id ?? ctx.existing?.rfq_id)
    const linked = rfqId
      ? await countWhere(
          `SELECT COUNT(*) AS n FROM procurement_purchase_orders WHERE tenant_id = ? AND rfq_id = ? AND status <> 'Cancelled'`,
          [tenantId, rfqId],
        )
      : 0
    const err = evaluateRfqCancellation("Cancelled", { linkedPoCount: linked })
    if (err) return err
  }
  return null
}

const DERIVED_PO_STATUSES = new Set(["Partially Received", "Received"])

export async function guardPoWrite(merged: Record<string, any>, ctx: GuardCtx): Promise<string | null> {
  const tenantId = await requireProcurementTenant()
  const who = await actor()
  const prevStatus = ctx.existing?.approval_status ?? null
  const nextStatus = merged.approval_status ?? prevStatus ?? "Draft"

  if (num(merged.unit_price) < 0) return "Unit price cannot be negative."
  if (num(merged.gst_rate) < 0 || num(merged.gst_rate) > 100) return "GST rate must be between 0 and 100."
  if (num(merged.discount_percent) < 0 || num(merged.discount_percent) > 100) return "Discount must be between 0 and 100 percent."

  const transition = evaluateApprovalTransition(prevStatus, nextStatus, { isCreate: ctx.isCreate, documentLabel: "purchase order" })
  if (transition) return transition

  const locked = evaluateApprovedImmutability(ctx.existing, ctx.body ?? {}, PO_LOCKED, "purchase order")
  if (locked) return locked

  const sod = evaluateSodApproval({
    actorUserId: who.id,
    creatorUserId: ctx.existing?.created_by ?? null,
    prevStatus,
    nextStatus,
    documentLabel: "purchase order",
  })
  if (sod) return sod

  // Fulfilment statuses are derived from goods receipts only.
  const prevFulfil = s(ctx.existing?.status)
  const nextFulfil = s(merged.status)
  if (DERIVED_PO_STATUSES.has(nextFulfil) && nextFulfil !== prevFulfil) {
    return `Purchase order status "${nextFulfil}" is set automatically from goods receipts.`
  }
  if ((nextFulfil === "Sent" || nextFulfil === "Closed") && s(nextStatus) !== "Approved") {
    return `A purchase order must be approved before it can be marked ${nextFulfil}.`
  }
  if (prevFulfil === "Cancelled" && nextFulfil !== "Cancelled") return "A cancelled purchase order cannot be reopened."

  const reqRef = s(merged.requisition_id)
  const rfqRef = s(merged.rfq_id)
  const requisition = reqRef ? await findRequisition(tenantId, reqRef) : null
  const rfq = rfqRef ? await findRfq(tenantId, rfqRef) : null

  const chain = evaluatePoChain({ requisitionRef: reqRef, requisition, rfqRef, rfq })
  if (chain) return chain
  if (requisition && s(requisition.requisition_status) === "Cancelled") {
    return `Purchase order cannot reference cancelled requisition ${reqRef}.`
  }
  if (rfq && reqRef && s(rfq.requisition_id) && s(rfq.requisition_id) !== reqRef) {
    return `RFQ ${rfqRef} belongs to requisition ${s(rfq.requisition_id)}, not ${reqRef}.`
  }

  const poNumber = s(merged.po_number ?? ctx.existing?.po_number)
  const otherOrdered = requisition
    ? num(
        ((await query(
          `SELECT COALESCE(SUM(quantity),0) AS s FROM procurement_purchase_orders
             WHERE tenant_id = ? AND requisition_id = ? AND status <> 'Cancelled' AND po_number <> ?`,
          [tenantId, reqRef, poNumber || "__none__"],
        )) as any[])[0]?.s,
      )
    : 0
  const upstream = evaluatePoAgainstUpstream({
    poQuantity: merged.quantity,
    poTaxable: merged.taxable_amount,
    poVendorId: merged.vendor_id,
    poVendorName: merged.vendor_name,
    requisition,
    rfq,
    otherOrderedQuantity: otherOrdered,
  })
  if (upstream) return upstream

  if (s(nextStatus) === "Approved" && s(prevStatus) !== "Approved") {
    const budgetErr = await checkBudget(
      tenantId,
      merged.total_amount,
      {
        budgetRef: s(requisition?.budget_reference),
        department: s(merged.department ?? requisition?.department),
        fy: s(merged.financial_year ?? requisition?.financial_year),
      },
      { excludeRequisition: reqRef, excludePo: poNumber },
    )
    if (budgetErr) return budgetErr
  }

  if (nextFulfil === "Cancelled" && prevFulfil !== "Cancelled" && poNumber) {
    const grnCount = await countWhere(
      `SELECT COUNT(*) AS n FROM procurement_goods_receipts WHERE tenant_id = ? AND po_number = ?`,
      [tenantId, poNumber],
    )
    const err = evaluatePoCancellation("Cancelled", { grnCount, billCount: await countBillsForPo(poNumber) })
    if (err) return err
  }
  return null
}

export async function guardGrnWrite(merged: Record<string, any>, ctx: GuardCtx): Promise<string | null> {
  const tenantId = await requireProcurementTenant()
  const who = await actor()
  const poRef = s(merged.po_number)
  const po = poRef ? await findPo(tenantId, poRef) : null

  const chain = evaluateGrnChain({ poRef, po, receivedQuantity: merged.received_quantity })
  if (chain) return chain
  if (!po) return null

  if (!ctx.isCreate && ctx.existing && s(ctx.existing.po_number) !== poRef) {
    return "A goods receipt cannot be moved to a different purchase order."
  }

  const grnId = s(merged.grn_id ?? ctx.existing?.grn_id)
  const qty = evaluateGrnQuantities({
    orderedQuantity: po.quantity,
    alreadyReceived: await receivedOnOtherGrns(tenantId, poRef, grnId),
    receivedQuantity: merged.received_quantity,
    acceptedQuantity: merged.accepted_quantity ?? merged.received_quantity,
    rejectedQuantity: merged.rejected_quantity ?? 0,
  })
  if (qty) return qty

  const sod = evaluateGrnSod(who.id, po.approved_by_user_id)
  if (sod) return sod

  if (!ctx.isCreate && (await countBillsForPo(poRef)) > 0) {
    const changed = ["received_quantity", "accepted_quantity", "rejected_quantity"].some(
      (k) => ctx.body && k in ctx.body && num(ctx.body[k]) !== num(ctx.existing?.[k]),
    )
    if (changed) return `Receipt quantities are frozen: a vendor bill has already been booked against purchase order ${poRef}.`
  }
  return null
}

/**
 * Server-authoritative GRN fields: the ordered quantity, price, vendor and
 * item always come from the tenant's PO (never the browser), and the pending /
 * status band is cumulative across every receipt of the PO.
 */
export async function augmentGoodsReceipt(merged: Record<string, any>): Promise<Record<string, any>> {
  const tenantId = await requireProcurementTenant()
  const poRef = s(merged.po_number)
  const po = poRef ? await findPo(tenantId, poRef) : null
  if (!po) return {}
  const received = num(merged.received_quantity)
  const accepted = merged.accepted_quantity == null || s(merged.accepted_quantity) === "" ? received : num(merged.accepted_quantity)
  const rejected = merged.rejected_quantity == null || s(merged.rejected_quantity) === "" ? round2(received - accepted) : num(merged.rejected_quantity)
  const unitPrice = netUnitPrice(po)
  const already = await receivedOnOtherGrns(tenantId, poRef, s(merged.grn_id))
  const cumulative = deriveGrnFields({
    ordered_quantity: po.quantity,
    received_quantity: already + received,
    accepted_quantity: already + received,
    unit_price: unitPrice,
  })
  return {
    ordered_quantity: num(po.quantity),
    unit_price: unitPrice,
    vendor_name: po.vendor_name ?? merged.vendor_name ?? null,
    item_description: merged.item_description || po.item_description || null,
    uom: merged.uom || po.uom || null,
    accepted_quantity: accepted,
    rejected_quantity: Math.max(0, rejected),
    pending_quantity: cumulative.pending_quantity,
    received_value: round2(accepted * unitPrice),
    receipt_status: cumulative.receipt_status,
  }
}

/**
 * Vendor invoice (purchase bill) linked to a procurement PO: the PO must be
 * the tenant's, approved and live, goods must have been received, the vendor
 * and GST rate must match, and cumulative billing cannot exceed the accepted
 * received value (three-way match). Payment recorded on a linked bill is
 * capped at the payable and may not be recorded by the PO's approver.
 */
export async function guardPurchaseBillProcurementLink(
  merged: Record<string, any>,
  ctx: GuardCtx,
): Promise<string | null> {
  const poRef = s(merged.po_number)
  const poChanged = ctx.isCreate || s(ctx.existing?.po_number) !== poRef

  const payable = num(merged.net_payable) || num(merged.gross_bill_amount)
  const basicPayment = evaluateBillPayment({
    amountPaid: merged.amount_paid,
    payable,
    previousPaid: ctx.existing?.amount_paid ?? 0,
    chainError: null,
  })
  if (basicPayment) return basicPayment
  if (!poRef) return null

  await ensureProcurementSchema()
  const tenantId = await requireProcurementTenant()
  const po = await findPo(tenantId, poRef)
  if (!po) {
    // Legacy bills carry free-text PO numbers; only a new or changed link must resolve.
    return poChanged ? `Vendor bill references purchase order ${poRef}, which does not exist in this workspace.` : null
  }

  const grnRef = s(merged.grn_number)
  if (grnRef) {
    const grnOnPo = await countWhere(
      `SELECT COUNT(*) AS n FROM procurement_goods_receipts WHERE tenant_id = ? AND grn_id = ? AND po_number = ?`,
      [tenantId, grnRef, poRef],
    )
    if (!grnOnPo) return `Goods receipt ${grnRef} does not belong to purchase order ${poRef}.`
  }

  const grnAgg = ((await query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(received_value),0) AS v FROM procurement_goods_receipts WHERE tenant_id = ? AND po_number = ?`,
    [tenantId, poRef],
  )) as any[])[0]
  let otherBilled = 0
  try {
    const rows = (await query(
      `SELECT COALESCE(SUM(taxable_amount),0) AS s FROM purchase_bills WHERE po_number = ? AND bill_id <> ?`,
      [poRef, s(merged.bill_id ?? ctx.existing?.bill_id) || "__none__"],
    )) as any[]
    otherBilled = num(rows[0]?.s)
  } catch {
    otherBilled = 0
  }

  const chainError = evaluateBillAgainstPo({
    po,
    poRef,
    billVendorId: merged.vendor_id,
    billVendorName: merged.vendor_name,
    billTaxable: merged.taxable_amount,
    billGstRate: merged.gst_rate,
    receivedValue: grnAgg?.v,
    otherBilledTaxable: otherBilled,
    grnCount: num(grnAgg?.n),
  })
  if (chainError) return chainError

  const who = await actor()
  const paymentSod =
    who.id != null && po.approved_by_user_id != null && Number(who.id) === Number(po.approved_by_user_id)
      ? "segregation of duties — the purchase order approver cannot record payment against its vendor bill."
      : null
  const basic = evaluateBillPayment({
    amountPaid: merged.amount_paid,
    payable,
    previousPaid: ctx.existing?.amount_paid ?? 0,
    chainError: paymentSod,
  })
  if (basic) return basic

  // Spec37 (#201) — three-way match payment hold. Only gates an INCREASE in
  // payment, so an unpaid bill can still be saved/edited while its exception is
  // pending; the checker resolves the hold from the Three-Way Match screen.
  const increasing = num(merged.amount_paid) > num(ctx.existing?.amount_paid ?? 0)
  if (increasing) {
    const hold = await evaluateBillPaymentHold(tenantId, {
      bill_id: merged.bill_id ?? ctx.existing?.bill_id,
      po_number: poRef,
      grn_number: merged.grn_number,
      vendor_id: merged.vendor_id,
      vendor_name: merged.vendor_name,
      bill_number: merged.bill_number,
      taxable_amount: merged.taxable_amount,
      gst_rate: merged.gst_rate,
      currency: merged.currency,
    })
    if (hold) return hold
  }
  return null
}

// ---------------------------------------------------------------------------
// Delete guards — approved / linked documents cannot be deleted.
// ---------------------------------------------------------------------------

export async function guardProcurementDelete(moduleKey: string, row: Record<string, any>): Promise<string | null> {
  const tenantId = await requireProcurementTenant()
  if (moduleKey === "purchase-requisition") {
    const ref = s(row.requisition_id)
    const downstream =
      (await countWhere(`SELECT COUNT(*) AS n FROM procurement_rfqs WHERE tenant_id = ? AND requisition_id = ?`, [tenantId, ref])) +
      (await countWhere(`SELECT COUNT(*) AS n FROM procurement_purchase_orders WHERE tenant_id = ? AND requisition_id = ?`, [tenantId, ref]))
    return evaluateProcurementDelete(row, { downstreamCount: downstream, documentLabel: "requisition" })
  }
  if (moduleKey === "rfq") {
    const downstream = await countWhere(
      `SELECT COUNT(*) AS n FROM procurement_purchase_orders WHERE tenant_id = ? AND rfq_id = ?`,
      [tenantId, s(row.rfq_id)],
    )
    return evaluateProcurementDelete(row, { downstreamCount: downstream, documentLabel: "RFQ" })
  }
  if (moduleKey === "purchase-orders") {
    const ref = s(row.po_number)
    const downstream =
      (await countWhere(`SELECT COUNT(*) AS n FROM procurement_goods_receipts WHERE tenant_id = ? AND po_number = ?`, [tenantId, ref])) +
      (await countBillsForPo(ref))
    return evaluateProcurementDelete(row, { downstreamCount: downstream, documentLabel: "purchase order" })
  }
  if (moduleKey === "goods-receipt") {
    const bills = await countBillsForPo(s(row.po_number))
    return bills > 0
      ? `This goods receipt cannot be deleted: ${bills} vendor bill(s) are booked against purchase order ${s(row.po_number)}.`
      : null
  }
  return null
}

// ---------------------------------------------------------------------------
// After-write side effects — status propagation + audit. Each transition is
// only logged when it changes something, so an idempotent replay or a plain
// re-save never creates duplicate audit rows.
// ---------------------------------------------------------------------------

type AfterCtx = {
  finalRow: Record<string, any>
  isCreate: boolean
  existing: Record<string, any> | null
  userId: number
}

export async function afterRequisitionWrite(ctx: AfterCtx): Promise<void> {
  const tenantId = await requireProcurementTenant()
  const row = ctx.finalRow
  const reqId = s(row.requisition_id)
  const prev = ctx.existing?.approval_status ?? null
  const next = row.approval_status ?? null
  const { name } = await actor()
  const base = { entityType: "procurement_requisition", entityPk: row.id != null ? Number(row.id) : null, entityRef: reqId, actorId: ctx.userId, actorName: name }

  if (ctx.isCreate) {
    await logFinanceEvent({ ...base, type: "created", summary: `Requisition ${reqId} created`, amount: num(row.estimated_amount) })
    return
  }
  if (s(prev) !== s(next)) {
    if (s(next) === "Approved") {
      await query(
        `UPDATE procurement_requisitions SET approved_by = ?, approved_by_user_id = ?, approval_date = CURDATE() WHERE tenant_id = ? AND requisition_id = ?`,
        [name, ctx.userId, tenantId, reqId],
      )
    }
    await logFinanceEvent({
      ...base,
      type: next === "Approved" ? "approved" : next === "Rejected" ? "rejected" : "updated",
      summary: `Requisition ${reqId} status ${prev || "—"} → ${next || "—"}`,
      detail: { from: prev, to: next },
      amount: num(row.estimated_amount),
    })
  }
  if (s(row.requisition_status) === "Cancelled" && s(ctx.existing?.requisition_status) !== "Cancelled") {
    await logFinanceEvent({ ...base, type: "updated", summary: `Requisition ${reqId} cancelled`, detail: { cancelled: true } })
  }
}

export async function afterRfqWrite(ctx: AfterCtx): Promise<void> {
  const tenantId = await requireProcurementTenant()
  const row = ctx.finalRow
  const rfqId = s(row.rfq_id)
  const prev = s(ctx.existing?.status)
  const next = s(row.status)
  const { name } = await actor()
  const base = { entityType: "procurement_rfq", entityPk: row.id != null ? Number(row.id) : null, entityRef: rfqId, actorId: ctx.userId, actorName: name }

  if (ctx.isCreate) {
    await logFinanceEvent({ ...base, type: "created", summary: `RFQ ${rfqId} created` })
  }
  if (next === "Awarded" && prev !== "Awarded") {
    await query(`UPDATE procurement_rfqs SET awarded_by_user_id = ? WHERE tenant_id = ? AND rfq_id = ?`, [ctx.userId, tenantId, rfqId])
    const reqRef = s(row.requisition_id)
    if (reqRef) {
      await query(
        `UPDATE procurement_requisitions SET requisition_status = 'In RFQ' WHERE tenant_id = ? AND requisition_id = ? AND requisition_status = 'Open'`,
        [tenantId, reqRef],
      )
    }
    await logFinanceEvent({
      ...base,
      type: "approved",
      summary: `RFQ ${rfqId} awarded to ${row.selected_vendor_name || "vendor"}`,
      amount: num(row.awarded_amount),
    })
  }
  if (next === "Cancelled" && prev !== "Cancelled" && !ctx.isCreate) {
    await logFinanceEvent({ ...base, type: "updated", summary: `RFQ ${rfqId} cancelled` })
  }
}

export async function afterPoWrite(ctx: AfterCtx): Promise<void> {
  const tenantId = await requireProcurementTenant()
  const row = ctx.finalRow
  const poNumber = s(row.po_number)
  const prev = ctx.existing?.approval_status ?? null
  const next = row.approval_status ?? null
  const { name } = await actor()
  const base = { entityType: "procurement_po", entityPk: row.id != null ? Number(row.id) : null, entityRef: poNumber, actorId: ctx.userId, actorName: name }

  if (ctx.isCreate) {
    await logFinanceEvent({ ...base, type: "created", summary: `Purchase order ${poNumber} created`, amount: num(row.total_amount) })
  }
  if (s(prev) !== s(next) && s(next) === "Approved") {
    await query(
      `UPDATE procurement_purchase_orders
          SET approved_by = ?, approved_by_user_id = ?, approval_date = CURDATE(),
              status = CASE WHEN status = 'Draft' THEN 'Approved' ELSE status END
        WHERE tenant_id = ? AND po_number = ?`,
      [name, ctx.userId, tenantId, poNumber],
    )
    const reqRef = s(row.requisition_id)
    if (reqRef) {
      await query(
        `UPDATE procurement_requisitions SET requisition_status = 'In PO'
           WHERE tenant_id = ? AND requisition_id = ? AND requisition_status IN ('Open','In RFQ')`,
        [tenantId, reqRef],
      )
    }
    await logFinanceEvent({ ...base, type: "approved", summary: `Purchase order ${poNumber} approved`, amount: num(row.total_amount) })
  }
  if (s(prev) !== s(next) && s(next) === "Rejected") {
    await logFinanceEvent({ ...base, type: "rejected", summary: `Purchase order ${poNumber} rejected` })
  }
  if (s(row.status) === "Cancelled" && s(ctx.existing?.status) !== "Cancelled" && !ctx.isCreate) {
    await logFinanceEvent({ ...base, type: "updated", summary: `Purchase order ${poNumber} cancelled`, amount: num(row.total_amount) })
    // Release the requisition back to Open when no other live PO covers it.
    const reqRef = s(row.requisition_id)
    if (reqRef) {
      const live = await countWhere(
        `SELECT COUNT(*) AS n FROM procurement_purchase_orders WHERE tenant_id = ? AND requisition_id = ? AND status <> 'Cancelled'`,
        [tenantId, reqRef],
      )
      if (live === 0) {
        await query(
          `UPDATE procurement_requisitions SET requisition_status = 'Open' WHERE tenant_id = ? AND requisition_id = ? AND requisition_status = 'In PO'`,
          [tenantId, reqRef],
        )
      }
    }
  }
}

/** Recompute a PO's fulfilment from all its receipts (after GRN write or delete). */
export async function recomputePoFulfilment(tenantId: number, poNumber: string, userId: number | null): Promise<void> {
  const po = await findPo(tenantId, poNumber)
  if (!po) return
  const rows = (await query(
    `SELECT COALESCE(SUM(received_quantity),0) AS total FROM procurement_goods_receipts WHERE tenant_id = ? AND po_number = ?`,
    [tenantId, poNumber],
  )) as any[]
  const totalReceived = num(rows[0]?.total)
  const baseline = s(po.status) === "Partially Received" || s(po.status) === "Received" ? "Approved" : s(po.status)
  const newStatus = totalReceived > 0 ? derivePoFulfilmentStatus(po.quantity, totalReceived, po.status) : baseline
  if (newStatus === s(po.status)) return

  await query(`UPDATE procurement_purchase_orders SET status = ? WHERE tenant_id = ? AND po_number = ?`, [newStatus, tenantId, poNumber])
  const { name } = await actor()
  await logFinanceEvent({
    entityType: "procurement_po",
    entityRef: poNumber,
    type: "updated",
    summary: `Purchase order ${poNumber} fulfilment ${po.status || "—"} → ${newStatus}`,
    detail: { from: po.status, to: newStatus, totalReceived },
    actorId: userId,
    actorName: name,
  })
  if (po.requisition_id) {
    if (newStatus === "Received") {
      await query(
        `UPDATE procurement_requisitions SET requisition_status = 'Fulfilled' WHERE tenant_id = ? AND requisition_id = ? AND requisition_status <> 'Cancelled'`,
        [tenantId, s(po.requisition_id)],
      )
    } else if (s(po.status) === "Received") {
      await query(
        `UPDATE procurement_requisitions SET requisition_status = 'In PO' WHERE tenant_id = ? AND requisition_id = ? AND requisition_status = 'Fulfilled'`,
        [tenantId, s(po.requisition_id)],
      )
    }
  }
}

export async function afterGrnWrite(ctx: AfterCtx): Promise<void> {
  const tenantId = await requireProcurementTenant()
  const row = ctx.finalRow
  const grnId = s(row.grn_id)
  const poNumber = s(row.po_number)
  const { name } = await actor()
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
  if (poNumber) await recomputePoFulfilment(tenantId, poNumber, ctx.userId)
}

export async function afterGrnDelete(row: Record<string, any>): Promise<void> {
  const tenantId = await requireProcurementTenant()
  const { id, name } = await actor()
  await logFinanceEvent({
    entityType: "procurement_grn",
    entityPk: row.id != null ? Number(row.id) : null,
    entityRef: s(row.grn_id),
    type: "updated",
    summary: `Goods receipt ${s(row.grn_id)} deleted`,
    actorId: id,
    actorName: name,
  })
  if (s(row.po_number)) await recomputePoFulfilment(tenantId, s(row.po_number), id)
}

// ---------------------------------------------------------------------------
// Read models for the procurement hub + approval queue.
// ---------------------------------------------------------------------------

export async function getProcurementChain(tenantId: number) {
  await ensureProcurementSchema()
  const requisitions = (await query(
    `SELECT id, requisition_id, title, department, estimated_amount, approval_status, requisition_status, created_at
       FROM procurement_requisitions WHERE tenant_id = ? ORDER BY id DESC LIMIT 100`,
    [tenantId],
  )) as any[]
  const rfqs = (await query(
    `SELECT rfq_id, requisition_id, status, quote_count, awarded_amount, selected_vendor_name,
            vendor_1_name, vendor_1_quote, vendor_2_name, vendor_2_quote, vendor_3_name, vendor_3_quote, lowest_quote
       FROM procurement_rfqs WHERE tenant_id = ? ORDER BY id DESC LIMIT 200`,
    [tenantId],
  )) as any[]
  const pos = (await query(
    `SELECT po_number, requisition_id, rfq_id, vendor_name, quantity, taxable_amount, gst_amount, total_amount, approval_status, status
       FROM procurement_purchase_orders WHERE tenant_id = ? ORDER BY id DESC LIMIT 200`,
    [tenantId],
  )) as any[]
  const grns = (await query(
    `SELECT po_number, COUNT(*) AS receipts, COALESCE(SUM(received_quantity),0) AS received_quantity, COALESCE(SUM(received_value),0) AS received_value
       FROM procurement_goods_receipts WHERE tenant_id = ? GROUP BY po_number`,
    [tenantId],
  )) as any[]

  const poNumbers = pos.map((p) => String(p.po_number))
  let bills: any[] = []
  if (poNumbers.length) {
    try {
      bills = (await query(
        `SELECT po_number, COUNT(*) AS bills, COALESCE(SUM(taxable_amount),0) AS billed_taxable,
                COALESCE(SUM(net_payable),0) AS payable, COALESCE(SUM(amount_paid),0) AS paid
           FROM purchase_bills WHERE po_number IN (${poNumbers.map(() => "?").join(",")}) GROUP BY po_number`,
        poNumbers,
      )) as any[]
    } catch {
      bills = []
    }
  }
  const grnByPo = new Map(grns.map((g) => [String(g.po_number), g]))
  const billByPo = new Map(bills.map((b) => [String(b.po_number), b]))

  const orders = pos.map((p) => {
    const g = grnByPo.get(String(p.po_number))
    const b = billByPo.get(String(p.po_number))
    return {
      ...p,
      receipts: num(g?.receipts),
      received_quantity: num(g?.received_quantity),
      received_value: num(g?.received_value),
      bills: num(b?.bills),
      billed_taxable: num(b?.billed_taxable),
      payable: num(b?.payable),
      paid: num(b?.paid),
    }
  })

  const summary = {
    requisitions: requisitions.length,
    pendingApprovals:
      requisitions.filter((r) => r.approval_status === "Submitted").length +
      pos.filter((p) => p.approval_status === "Submitted").length,
    openOrders: pos.filter((p) => p.approval_status === "Approved" && !["Received", "Closed", "Cancelled"].includes(p.status)).length,
    committedValue: round2(pos.filter((p) => p.approval_status === "Approved" && p.status !== "Cancelled").reduce((a, p) => a + num(p.total_amount), 0)),
    receivedValue: round2(orders.reduce((a, o) => a + o.received_value, 0)),
    paidValue: round2(orders.reduce((a, o) => a + o.paid, 0)),
  }
  return { summary, requisitions, rfqs, orders }
}

export async function getPendingProcurementApprovals(tenantId: number, viewerUserId: number) {
  await ensureProcurementSchema()
  const reqs = (await query(
    `SELECT r.id, r.requisition_id AS ref, r.title, r.department, r.estimated_amount AS amount, r.created_by, u.name AS created_by_name, r.created_at
       FROM procurement_requisitions r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.tenant_id = ? AND r.approval_status = 'Submitted' ORDER BY r.id ASC LIMIT 200`,
    [tenantId],
  )) as any[]
  const pos = (await query(
    `SELECT p.id, p.po_number AS ref, p.vendor_name AS title, p.requisition_id AS department, p.total_amount AS amount, p.created_by, u.name AS created_by_name, p.created_at
       FROM procurement_purchase_orders p LEFT JOIN users u ON u.id = p.created_by
      WHERE p.tenant_id = ? AND p.approval_status = 'Submitted' ORDER BY p.id ASC LIMIT 200`,
    [tenantId],
  )) as any[]
  const annotate = (moduleKey: string, rows: any[]) =>
    rows.map((r) => ({
      ...r,
      moduleKey,
      amount: num(r.amount),
      // Segregation of duties surfaced to the UI; the server re-checks on PATCH.
      canDecide: Number(r.created_by) !== Number(viewerUserId),
    }))
  return [...annotate("purchase-requisition", reqs), ...annotate("purchase-orders", pos)]
}
