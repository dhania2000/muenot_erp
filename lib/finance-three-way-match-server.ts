import "server-only"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { getTenantId } from "@/lib/api-auth"
import { logFinanceEvent } from "@/lib/finance-audit"
import { num, round2 } from "@/lib/finance-calc"
import { raiseApprovalRequest } from "@/lib/approval-authority"
import {
  evaluateThreeWayMatch,
  normalizeTolerances,
  summarizeMatch,
  DEFAULT_TOLERANCES,
  type MatchTolerances,
  type MatchResult,
  type MatchInput,
  type MatchReceipt,
} from "@/lib/finance-three-way-match"

/**
 * SPEC 141 / Spec37 (#201) — Purchase three-way matching (server side).
 *
 * Owns the tenant-scoped schema, persistence, audit and payment-hold decision
 * for the PO ⇄ GRN ⇄ vendor-bill match. Every read and write is bounded to the
 * acting tenant. All comparison DECISIONS live in the pure
 * lib/finance-three-way-match.ts — this module only gathers the three
 * documents, persists the result, and gates payment on unresolved exceptions.
 *
 * `purchase_bills` carries no tenant column, so sibling-bill totals and
 * duplicate detection read the tenant-scoped `finance_match_results` ledger
 * (one row per bill linked to a tenant PO) — never the unscoped bill table.
 */

export const MATCH_MODULE = "finance.three_way_match"
export const MATCH_APPROVAL_ENTITY = "finance_match_result"

export class MatchTenantError extends Error {
  constructor() {
    super("No tenant context for this three-way match request.")
  }
}

export async function requireMatchTenant(): Promise<number> {
  const tenantId = await getTenantId()
  if (tenantId == null) throw new MatchTenantError()
  return Number(tenantId)
}

// ---------------------------------------------------------------------------
// Schema — idempotent, once per process. Mirrors
// database/migrations/2027-01-30-spec37-three-way-matching.sql (+ the 2027-02-02
// follow-up) for managed deploys.
// ---------------------------------------------------------------------------

let schemaEnsured = false

async function ensureColumn(table: string, column: string, ddl: string): Promise<void> {
  const rows = (await query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  )) as any[]
  if (num(rows[0]?.n) === 0) await query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}

export async function ensureMatchSchema(): Promise<void> {
  if (schemaEnsured) return

  await query(`CREATE TABLE IF NOT EXISTS finance_match_config (
    tenant_id            INT NOT NULL,
    quantity_percent     DECIMAL(9,2) NOT NULL DEFAULT 0,
    price_percent        DECIMAL(9,2) NOT NULL DEFAULT 0,
    amount_percent       DECIMAL(9,2) NOT NULL DEFAULT 0,
    amount_absolute      DECIMAL(14,2) NOT NULL DEFAULT 1,
    updated_by           INT DEFAULT NULL,
    updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS finance_match_results (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id            INT NOT NULL,
    bill_id              VARCHAR(30) NOT NULL,
    po_number            VARCHAR(30) DEFAULT NULL,
    grn_number           VARCHAR(60) DEFAULT NULL,
    vendor_name          VARCHAR(190) DEFAULT NULL,
    match_status         VARCHAR(30) NOT NULL DEFAULT 'exception',
    payment_hold         TINYINT(1) NOT NULL DEFAULT 0,
    categories           TEXT DEFAULT NULL,
    evidence             MEDIUMTEXT DEFAULT NULL,
    resolution_status    VARCHAR(20) NOT NULL DEFAULT 'open',
    resolution_note      TEXT DEFAULT NULL,
    resolved_by          INT DEFAULT NULL,
    resolved_by_name     VARCHAR(190) DEFAULT NULL,
    resolved_at          DATETIME DEFAULT NULL,
    resolved_categories  TEXT DEFAULT NULL,
    computed_by          INT DEFAULT NULL,
    computed_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_match_tenant_bill (tenant_id, bill_id),
    KEY idx_match_po (tenant_id, po_number),
    KEY idx_match_hold (tenant_id, payment_hold),
    KEY idx_match_status (tenant_id, match_status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // Tenant-scoped bill ledger fields (sibling totals + duplicate detection) and
  // the approval-inbox binding.
  await ensureColumn("finance_match_results", "bill_number", "bill_number VARCHAR(80) DEFAULT NULL")
  await ensureColumn("finance_match_results", "vendor_id", "vendor_id VARCHAR(60) DEFAULT NULL")
  await ensureColumn("finance_match_results", "currency", "currency VARCHAR(10) DEFAULT NULL")
  await ensureColumn("finance_match_results", "billed_quantity", "billed_quantity DECIMAL(14,3) NOT NULL DEFAULT 0")
  await ensureColumn("finance_match_results", "billed_taxable", "billed_taxable DECIMAL(14,2) NOT NULL DEFAULT 0")
  await ensureColumn("finance_match_results", "approval_request_id", "approval_request_id INT DEFAULT NULL")

  await query(`CREATE TABLE IF NOT EXISTS finance_match_events (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id            INT NOT NULL,
    bill_id              VARCHAR(30) NOT NULL,
    event_type           VARCHAR(30) NOT NULL,
    summary              VARCHAR(500) NOT NULL,
    detail               MEDIUMTEXT DEFAULT NULL,
    actor_id             INT DEFAULT NULL,
    actor_name           VARCHAR(190) DEFAULT NULL,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_match_events_bill (tenant_id, bill_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await query(`CREATE TABLE IF NOT EXISTS finance_match_idempotency (
    tenant_id            INT NOT NULL,
    idem_key             VARCHAR(100) NOT NULL,
    bill_id              VARCHAR(30) NOT NULL,
    decision             VARCHAR(10) NOT NULL,
    response             MEDIUMTEXT NOT NULL,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, idem_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  schemaEnsured = true
}

/** Test hook — lets unit tests re-run the schema ensure against a fresh mock. */
export function __resetMatchSchemaForTests(): void {
  schemaEnsured = false
}

async function tableExists(name: string): Promise<boolean> {
  const rows = (await query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [name],
  )) as any[]
  return num(rows[0]?.n) > 0
}

const s = (v: unknown) => String(v ?? "").trim()

async function actor(): Promise<{ id: number | null; name: string | null }> {
  const session = await getSession()
  return { id: session ? Number(session.userId) : null, name: session?.name ?? null }
}

/** Tenant-scoped match audit trail (plus the global finance audit log). */
async function recordMatchEvent(
  tenantId: number,
  billId: string,
  type: "computed" | "approved" | "rejected" | "reopened" | "config" | "deleted" | "approval_raised",
  summary: string,
  detail: Record<string, unknown>,
  who: { id: number | null; name: string | null },
): Promise<void> {
  try {
    await query(
      `INSERT INTO finance_match_events (tenant_id, bill_id, event_type, summary, detail, actor_id, actor_name)
         VALUES (?,?,?,?,?,?,?)`,
      [tenantId, billId, type, summary.slice(0, 500), JSON.stringify(detail), who.id, who.name],
    )
  } catch (error) {
    console.error("[v0] recordMatchEvent failed:", (error as Error).message)
  }
  const financeType = type === "approved" ? "approved" : type === "rejected" ? "rejected" : "updated"
  await logFinanceEvent({
    entityType: MATCH_APPROVAL_ENTITY,
    entityRef: billId,
    type: financeType,
    summary,
    detail: { tenantId, ...detail },
    actorId: who.id,
    actorName: who.name,
  })
}

export type MatchEvent = {
  id: number
  type: string
  summary: string
  detail: Record<string, unknown> | null
  actorId: number | null
  actorName: string | null
  createdAt: string | null
}

export async function listMatchEvents(tenantId: number, billId: string): Promise<MatchEvent[]> {
  await ensureMatchSchema()
  const rows = (await query(
    `SELECT id, event_type, summary, detail, actor_id, actor_name, created_at FROM finance_match_events
      WHERE tenant_id = ? AND bill_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`,
    [tenantId, billId],
  )) as any[]
  return rows.map((r) => ({
    id: Number(r.id),
    type: s(r.event_type),
    summary: s(r.summary),
    detail: safeParse(r.detail),
    actorId: r.actor_id != null ? Number(r.actor_id) : null,
    actorName: r.actor_name != null ? s(r.actor_name) : null,
    createdAt: r.created_at != null ? String(r.created_at) : null,
  }))
}

// ---------------------------------------------------------------------------
// Tolerance config.
// ---------------------------------------------------------------------------

export async function getMatchTolerances(tenantId: number): Promise<MatchTolerances> {
  await ensureMatchSchema()
  const rows = (await query(
    `SELECT quantity_percent, price_percent, amount_percent, amount_absolute FROM finance_match_config WHERE tenant_id = ? LIMIT 1`,
    [tenantId],
  )) as any[]
  if (!rows[0]) return { ...DEFAULT_TOLERANCES }
  return normalizeTolerances({
    quantityPercent: rows[0].quantity_percent,
    pricePercent: rows[0].price_percent,
    amountPercent: rows[0].amount_percent,
    amountAbsolute: rows[0].amount_absolute,
  })
}

export async function setMatchTolerances(
  tenantId: number,
  raw: Partial<MatchTolerances>,
  userId: number | null,
  userName: string | null = null,
): Promise<MatchTolerances> {
  await ensureMatchSchema()
  const before = await getMatchTolerances(tenantId)
  const tol = normalizeTolerances(raw)
  await query(
    `INSERT INTO finance_match_config (tenant_id, quantity_percent, price_percent, amount_percent, amount_absolute, updated_by)
       VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE quantity_percent = VALUES(quantity_percent), price_percent = VALUES(price_percent),
       amount_percent = VALUES(amount_percent), amount_absolute = VALUES(amount_absolute), updated_by = VALUES(updated_by)`,
    [tenantId, tol.quantityPercent, tol.pricePercent, tol.amountPercent, tol.amountAbsolute, userId],
  )
  await recordMatchEvent(tenantId, "__config__", "config", "Three-way match tolerances updated", { before, after: tol }, {
    id: userId,
    name: userName,
  })
  return tol
}

// ---------------------------------------------------------------------------
// Gather the three documents for a bill — tenant-scoped, server-authoritative.
// ---------------------------------------------------------------------------

export type BillRow = {
  bill_id?: unknown
  po_number?: unknown
  grn_number?: unknown
  vendor_id?: unknown
  vendor_name?: unknown
  bill_number?: unknown
  taxable_amount?: unknown
  gst_rate?: unknown
  currency?: unknown
}

async function findPo(tenantId: number, poRef: string) {
  if (!poRef) return null
  const rows = (await query(
    `SELECT po_number, quantity, unit_price, discount_percent, taxable_amount, gst_rate, currency, vendor_id, vendor_name, approved_by_user_id
       FROM procurement_purchase_orders WHERE tenant_id = ? AND po_number = ? LIMIT 1`,
    [tenantId, poRef],
  )) as any[]
  return rows[0] ?? null
}

/** Net PO unit price after its discount — the price a receipt is valued at. */
function netUnitPrice(po: Record<string, any>): number {
  const discount = Math.min(100, Math.max(0, num(po.discount_percent)))
  return round2(num(po.unit_price) * (1 - discount / 100))
}

/** Every goods receipt on the PO (split receipts), keyed by stable grn_id. */
async function grnReceipts(tenantId: number, poRef: string): Promise<MatchReceipt[]> {
  const rows = (await query(
    `SELECT grn_id, receipt_date, received_quantity, accepted_quantity, rejected_quantity, received_value
       FROM procurement_goods_receipts WHERE tenant_id = ? AND po_number = ? ORDER BY receipt_date, grn_id`,
    [tenantId, poRef],
  )) as any[]
  return rows.map((r) => ({
    grnId: s(r.grn_id),
    receiptDate: r.receipt_date != null ? String(r.receipt_date).slice(0, 10) : null,
    receivedQuantity: num(r.received_quantity),
    acceptedQuantity: num(r.accepted_quantity),
    rejectedQuantity: num(r.rejected_quantity),
    receivedValue: num(r.received_value),
  }))
}

/**
 * Quantity + taxable already billed on OTHER bills against the same PO, read
 * from the tenant-scoped ledger. Exported so the bill guard's overbilling check
 * shares the same scoped source.
 */
export async function billedOnPoForTenant(tenantId: number, poRef: string, excludeBillId: string) {
  await ensureMatchSchema()
  const rows = (await query(
    `SELECT COALESCE(SUM(billed_taxable),0) AS taxable, COALESCE(SUM(billed_quantity),0) AS qty
       FROM finance_match_results WHERE tenant_id = ? AND po_number = ? AND bill_id <> ?`,
    [tenantId, poRef, excludeBillId || "__none__"],
  )) as any[]
  return { taxable: num(rows[0]?.taxable), quantity: num(rows[0]?.qty) }
}

/** Same vendor bill number already booked for the same vendor in this tenant. */
async function findDuplicateBill(tenantId: number, bill: BillRow, excludeBillId: string): Promise<string | null> {
  const billNumber = s(bill.bill_number).toUpperCase()
  const vendorKey = s(bill.vendor_id) || s(bill.vendor_name)
  if (!billNumber || !vendorKey) return null
  const rows = (await query(
    `SELECT bill_id FROM finance_match_results
      WHERE tenant_id = ? AND UPPER(bill_number) = ? AND (vendor_id = ? OR (vendor_id IS NULL AND vendor_name = ?))
        AND bill_id <> ? LIMIT 1`,
    [tenantId, billNumber, vendorKey, s(bill.vendor_name), excludeBillId || "__none__"],
  )) as any[]
  return rows[0] ? s(rows[0].bill_id) : null
}

/**
 * Build the pure-engine input for a bill from the tenant's PO, goods receipts
 * and sibling bills. The bill's own billable quantity is the sum of its line
 * items when supplied, else derived from its taxable value at the PO net price.
 */
export async function gatherMatchInput(
  tenantId: number,
  bill: BillRow,
  opts?: { billQuantity?: unknown },
): Promise<{ input: MatchInput; po: Record<string, any> | null; poRef: string; billQuantity: number; duplicateOf: string | null }> {
  await ensureMatchSchema()
  const poRef = s(bill.po_number)
  const po = await findPo(tenantId, poRef)
  const excludeBillId = s(bill.bill_id)
  const billTaxable = round2(num(bill.taxable_amount))

  if (!po) {
    return {
      input: {
        orderedQuantity: 0,
        poUnitPrice: 0,
        poTaxable: 0,
        grnCount: 0,
        acceptedQuantity: 0,
        receivedValue: 0,
        billedQuantity: 0,
        billUnitPrice: 0,
        billTaxable,
        billGstRate: bill.gst_rate,
        billCurrency: bill.currency,
      },
      po: null,
      poRef,
      billQuantity: 0,
      duplicateOf: null,
    }
  }

  const receipts = await grnReceipts(tenantId, poRef)
  const accepted = receipts.reduce((a, r) => a + r.acceptedQuantity, 0)
  const receivedValue = receipts.reduce((a, r) => a + r.receivedValue, 0)
  const others = await billedOnPoForTenant(tenantId, poRef, excludeBillId)
  const duplicateOf = await findDuplicateBill(tenantId, bill, excludeBillId)
  const poUnit = netUnitPrice(po)
  const billQty =
    opts?.billQuantity != null && s(opts.billQuantity) !== ""
      ? Math.max(0, num(opts.billQuantity))
      : poUnit > 0
        ? round2(billTaxable / poUnit)
        : 0
  const billUnit = billQty > 0 ? round2(billTaxable / billQty) : poUnit

  return {
    input: {
      orderedQuantity: po.quantity,
      poUnitPrice: poUnit,
      poTaxable: po.taxable_amount,
      poCurrency: po.currency,
      poGstRate: po.gst_rate,
      grnCount: receipts.length,
      acceptedQuantity: accepted,
      receivedValue: round2(receivedValue),
      billedQuantity: billQty,
      billUnitPrice: billUnit,
      billTaxable,
      billCurrency: s(bill.currency) || po.currency,
      billGstRate: bill.gst_rate,
      otherBilledQuantity: others.quantity,
      otherBilledTaxable: others.taxable,
      duplicateBill: duplicateOf != null,
      receipts,
    },
    po,
    poRef,
    billQuantity: billQty,
    duplicateOf,
  }
}

// ---------------------------------------------------------------------------
// Compute + persist. A recompute that lands on the same exception set does
// not disturb an existing checker decision; a recompute that changes the
// exception set reopens the hold so a stale approval can never release payment.
// ---------------------------------------------------------------------------

export type ResolutionStatus = "open" | "approved" | "rejected"

export type PersistedMatch = {
  id: number | null
  billId: string
  billNumber: string | null
  poNumber: string | null
  grnNumber: string | null
  vendorName: string | null
  status: MatchResult["status"]
  paymentHold: boolean
  resolutionStatus: ResolutionStatus
  categories: string[]
  resolvedCategories: string[]
  resolvedBy: number | null
  resolvedByName: string | null
  resolvedAt: string | null
  resolutionNote: string | null
  approvalRequestId: number | null
  billedTaxable: number
  computedAt: string | null
  evidence: MatchResult
  summary: string
}

/** Pure: how a recompute carries a prior checker decision forward. */
export function carryResolution(
  prev: { resolution_status?: unknown; resolved_categories?: unknown } | null,
  categories: string[],
): ResolutionStatus {
  if (!prev || categories.length === 0) return "open"
  const prevStatus = s(prev.resolution_status)
  if ((prevStatus === "approved" || prevStatus === "rejected") && sameSet(parseList(prev.resolved_categories), categories)) {
    return prevStatus
  }
  return "open"
}

export async function computeAndPersistMatch(
  tenantId: number,
  bill: BillRow,
  opts?: { billQuantity?: unknown; userId?: number | null; userName?: string | null },
): Promise<PersistedMatch | null> {
  await ensureMatchSchema()
  const billId = s(bill.bill_id)
  if (!billId) throw new Error("A bill id is required to run three-way matching.")

  const { input, po, poRef, billQuantity, duplicateOf } = await gatherMatchInput(tenantId, bill, opts)
  if (!po) {
    // Unlinked / legacy free-text PO: nothing to match. Drop any stale row so it
    // no longer counts toward another bill's totals.
    await query(`DELETE FROM finance_match_results WHERE tenant_id = ? AND bill_id = ?`, [tenantId, billId])
    return null
  }

  const tol = await getMatchTolerances(tenantId)
  const result = evaluateThreeWayMatch(input, tol)
  const categories = result.categories as string[]
  const who = opts?.userId !== undefined ? { id: opts.userId ?? null, name: opts.userName ?? null } : await actor()

  const existing = (await query(
    `SELECT id, match_status, categories, resolution_status, resolved_categories, approval_request_id
       FROM finance_match_results WHERE tenant_id = ? AND bill_id = ? LIMIT 1`,
    [tenantId, billId],
  )) as any[]
  const prev = existing[0] ?? null

  const resolutionStatus = carryResolution(prev, categories)
  const keep = resolutionStatus !== "open"
  const effectiveHold = result.paymentHold && resolutionStatus !== "approved"
  const setChanged = !prev || !sameSet(parseList(prev.categories), categories)

  await query(
    `INSERT INTO finance_match_results
       (tenant_id, bill_id, bill_number, po_number, grn_number, vendor_id, vendor_name, currency, billed_quantity, billed_taxable,
        match_status, payment_hold, categories, evidence, resolution_status, computed_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       bill_number = VALUES(bill_number), po_number = VALUES(po_number), grn_number = VALUES(grn_number),
       vendor_id = VALUES(vendor_id), vendor_name = VALUES(vendor_name), currency = VALUES(currency),
       billed_quantity = VALUES(billed_quantity), billed_taxable = VALUES(billed_taxable),
       match_status = VALUES(match_status), payment_hold = VALUES(payment_hold), categories = VALUES(categories),
       evidence = VALUES(evidence), resolution_status = VALUES(resolution_status),
       resolved_categories = IF(${keep ? 1 : 0} = 1, resolved_categories, NULL),
       resolved_by = IF(${keep ? 1 : 0} = 1, resolved_by, NULL),
       resolved_by_name = IF(${keep ? 1 : 0} = 1, resolved_by_name, NULL),
       resolved_at = IF(${keep ? 1 : 0} = 1, resolved_at, NULL),
       resolution_note = IF(${keep ? 1 : 0} = 1, resolution_note, NULL),
       computed_by = VALUES(computed_by)`,
    [
      tenantId,
      billId,
      s(bill.bill_number) || null,
      poRef,
      s(bill.grn_number) || null,
      s(bill.vendor_id) || null,
      s(bill.vendor_name) || null,
      s(bill.currency) || s(po.currency) || null,
      round2(billQuantity),
      round2(num(bill.taxable_amount)),
      result.status,
      effectiveHold ? 1 : 0,
      JSON.stringify(categories),
      JSON.stringify({ ...result, duplicateOf }),
      resolutionStatus,
      who.id,
    ],
  )

  const freshRows = (await query(`SELECT * FROM finance_match_results WHERE tenant_id = ? AND bill_id = ? LIMIT 1`, [
    tenantId,
    billId,
  ])) as any[]
  const row = freshRows[0]

  if (setChanged || s(prev?.match_status) !== result.status) {
    const reopened = prev && s(prev.resolution_status) !== "open" && resolutionStatus === "open"
    await recordMatchEvent(
      tenantId,
      billId,
      reopened ? "reopened" : "computed",
      `Three-way match ${billId}: ${summarizeMatch(result)}${reopened ? " (prior decision voided — exception set changed)" : ""}`,
      { poNumber: poRef, status: result.status, categories, previousCategories: parseList(prev?.categories) },
      who,
    )
  }

  // Route an open exception to the approval inbox (once per exception set).
  if (row && result.paymentHold && resolutionStatus === "open" && (setChanged || row.approval_request_id == null)) {
    await cancelStaleApproval(tenantId, prev?.approval_request_id)
    await raiseMatchApproval(tenantId, row, result, who)
  }

  return row ? toPersisted(row) : null
}

async function cancelStaleApproval(tenantId: number, requestId: unknown): Promise<void> {
  if (requestId == null) return
  try {
    await query(
      `UPDATE approval_requests SET status = 'cancelled' WHERE id = ? AND tenant_id = ? AND status IN ('pending','in_progress')`,
      [Number(requestId), tenantId],
    )
  } catch {
    /* approval schema variant without these columns — the binding is cleared below anyway */
  }
  await query(`UPDATE finance_match_results SET approval_request_id = NULL WHERE tenant_id = ? AND approval_request_id = ?`, [
    tenantId,
    Number(requestId),
  ])
}

async function raiseMatchApproval(
  tenantId: number,
  row: Record<string, any>,
  result: MatchResult,
  who: { id: number | null; name: string | null },
): Promise<void> {
  if (who.id == null) return
  try {
    const raised = await raiseApprovalRequest({
      moduleKey: MATCH_MODULE,
      entityType: MATCH_APPROVAL_ENTITY,
      entityPk: Number(row.id),
      entityRef: s(row.bill_id),
      title: `Three-way match exception — ${s(row.bill_id)} (${summarizeMatch(result)})`,
      amount: num(row.billed_taxable),
      requestedBy: who.id,
      requestedByName: who.name,
    })
    // "No rule matched" auto-approval must NEVER release a payment hold: only a
    // pending request is bound; otherwise the checker resolves on the match screen.
    if (!raised.autoApproved) {
      await query(`UPDATE finance_match_results SET approval_request_id = ? WHERE tenant_id = ? AND id = ?`, [
        raised.requestId,
        tenantId,
        Number(row.id),
      ])
      await recordMatchEvent(tenantId, s(row.bill_id), "approval_raised", `Exception routed to approval inbox (request #${raised.requestId})`, {
        requestId: raised.requestId,
        categories: result.categories,
      }, who)
    }
  } catch (error) {
    console.error("[v0] raiseMatchApproval failed:", (error as Error).message)
  }
}

/** Unwind a deleted bill's match so it stops counting toward sibling totals. */
export async function deleteMatchForBill(tenantId: number, billId: string): Promise<void> {
  await ensureMatchSchema()
  const rows = (await query(`SELECT approval_request_id FROM finance_match_results WHERE tenant_id = ? AND bill_id = ? LIMIT 1`, [
    tenantId,
    billId,
  ])) as any[]
  if (!rows[0]) return
  await cancelStaleApproval(tenantId, rows[0].approval_request_id)
  await query(`DELETE FROM finance_match_results WHERE tenant_id = ? AND bill_id = ?`, [tenantId, billId])
  await recordMatchEvent(tenantId, billId, "deleted", `Vendor bill ${billId} deleted — match removed`, {}, await actor())
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

export async function getMatchForBill(tenantId: number, billId: string): Promise<PersistedMatch | null> {
  await ensureMatchSchema()
  const rows = (await query(`SELECT * FROM finance_match_results WHERE tenant_id = ? AND bill_id = ? LIMIT 1`, [tenantId, billId])) as any[]
  return rows[0] ? toPersisted(rows[0]) : null
}

/** Load the bill fields the engine needs, only when the bill is already in this tenant's ledger. */
export async function loadBillForRecompute(tenantId: number, billId: string): Promise<BillRow | null> {
  const owned = await getMatchForBill(tenantId, billId)
  if (!owned) return null
  const rows = (await query(
    `SELECT bill_id, po_number, grn_number, vendor_id, vendor_name, bill_number, taxable_amount, gst_rate, currency
       FROM purchase_bills WHERE bill_id = ? LIMIT 1`,
    [billId],
  )) as any[]
  return rows[0] ?? null
}

export async function listMatches(
  tenantId: number,
  filter?: { status?: string; holdOnly?: boolean; resolution?: string },
): Promise<PersistedMatch[]> {
  await ensureMatchSchema()
  const where: string[] = ["tenant_id = ?"]
  const args: unknown[] = [tenantId]
  if (filter?.status && filter.status !== "all") {
    where.push("match_status = ?")
    args.push(filter.status)
  }
  if (filter?.resolution && filter.resolution !== "all") {
    where.push("resolution_status = ?")
    args.push(filter.resolution)
  }
  if (filter?.holdOnly) where.push("payment_hold = 1")
  const rows = (await query(
    `SELECT * FROM finance_match_results WHERE ${where.join(" AND ")} ORDER BY payment_hold DESC, computed_at DESC LIMIT 500`,
    args,
  )) as any[]
  return rows.map(toPersisted)
}

// ---------------------------------------------------------------------------
// Exception resolution — an authorised checker approves or rejects the hold.
// Segregation of duties: the checker may not be the bill's creator, nor the PO
// approver. Every override is audited with the evidence and the note.
// ---------------------------------------------------------------------------

export type ResolveOutcome =
  | { ok: true; match: PersistedMatch; replayed?: boolean }
  | { ok: false; status: number; error: string }

export async function resolveMatchException(
  tenantId: number,
  billId: string,
  decision: "approve" | "reject",
  opts: { userId: number; userName: string | null; note?: string | null; idempotencyKey?: string | null; viaApprovalRequest?: number },
): Promise<ResolveOutcome> {
  await ensureMatchSchema()

  const idemKey = s(opts.idempotencyKey)
  if (idemKey) {
    const hit = (await query(`SELECT bill_id, decision, response FROM finance_match_idempotency WHERE tenant_id = ? AND idem_key = ? LIMIT 1`, [
      tenantId,
      idemKey,
    ])) as any[]
    if (hit[0]) {
      if (s(hit[0].bill_id) !== billId || s(hit[0].decision) !== decision) {
        return { ok: false, status: 409, error: "Idempotency-Key was already used for a different match decision." }
      }
      const replay = safeParse(hit[0].response)
      if (replay) return { ok: true, match: replay as PersistedMatch, replayed: true }
    }
  }

  const rows = (await query(`SELECT * FROM finance_match_results WHERE tenant_id = ? AND bill_id = ? LIMIT 1`, [tenantId, billId])) as any[]
  const row = rows[0]
  if (!row) return { ok: false, status: 404, error: "No three-way match record exists for this bill." }
  if (s(row.match_status) !== "exception") {
    return { ok: false, status: 409, error: "This match has no exception to resolve." }
  }

  const target: ResolutionStatus = decision === "approve" ? "approved" : "rejected"
  if (s(row.resolution_status) === target) {
    const match = toPersisted(row)
    await storeIdempotent(tenantId, idemKey, billId, decision, match)
    return { ok: true, match, replayed: true }
  }

  const sod = await checkResolveSod(tenantId, billId, s(row.po_number), opts.userId)
  if (sod) return { ok: false, status: 403, error: sod }

  const approve = decision === "approve"
  // Guard on the current state so two concurrent checkers cannot both apply.
  const upd = (await query(
    `UPDATE finance_match_results
       SET resolution_status = ?, payment_hold = ?, resolution_note = ?, resolved_by = ?, resolved_by_name = ?,
           resolved_at = NOW(), resolved_categories = ?
     WHERE tenant_id = ? AND bill_id = ? AND resolution_status = ? AND categories <=> ?`,
    [
      target,
      approve ? 0 : 1,
      s(opts.note) || null,
      opts.userId,
      opts.userName,
      row.categories,
      tenantId,
      billId,
      s(row.resolution_status),
      row.categories,
    ],
  )) as any
  if (upd && typeof upd.affectedRows === "number" && upd.affectedRows === 0) {
    return { ok: false, status: 409, error: "The match changed while you were reviewing it. Reload and try again." }
  }

  await recordMatchEvent(
    tenantId,
    billId,
    target,
    `Three-way match exception ${target} for ${billId} — ${s(opts.note)}`,
    {
      poNumber: s(row.po_number),
      categories: parseList(row.categories),
      decision,
      note: s(opts.note) || null,
      previousResolution: s(row.resolution_status),
      approvalRequestId: opts.viaApprovalRequest ?? null,
      evidence: safeParse(row.evidence),
    },
    { id: opts.userId, name: opts.userName },
  )

  const fresh = (await query(`SELECT * FROM finance_match_results WHERE tenant_id = ? AND bill_id = ? LIMIT 1`, [tenantId, billId])) as any[]
  const match = toPersisted(fresh[0] ?? { ...row, resolution_status: target, payment_hold: approve ? 0 : 1 })
  await storeIdempotent(tenantId, idemKey, billId, decision, match)
  return { ok: true, match }
}

async function storeIdempotent(tenantId: number, key: string, billId: string, decision: string, match: PersistedMatch) {
  if (!key) return
  await query(
    `INSERT IGNORE INTO finance_match_idempotency (tenant_id, idem_key, bill_id, decision, response) VALUES (?,?,?,?,?)`,
    [tenantId, key, billId, decision, JSON.stringify(match)],
  )
}

async function checkResolveSod(tenantId: number, billId: string, poRef: string, userId: number): Promise<string | null> {
  try {
    const billRows = (await query(`SELECT created_by FROM purchase_bills WHERE bill_id = ? LIMIT 1`, [billId])) as any[]
    if (billRows[0]?.created_by != null && Number(billRows[0].created_by) === Number(userId)) {
      return "Segregation of duties: the user who booked the vendor bill cannot approve its match exception."
    }
  } catch {
    /* purchase_bills may not track created_by in every install — skip */
  }
  if (poRef) {
    const poRows = (await query(
      `SELECT approved_by_user_id FROM procurement_purchase_orders WHERE tenant_id = ? AND po_number = ? LIMIT 1`,
      [tenantId, poRef],
    )) as any[]
    if (poRows[0]?.approved_by_user_id != null && Number(poRows[0].approved_by_user_id) === Number(userId)) {
      return "Segregation of duties: the purchase order approver cannot approve its own bill's match exception."
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Approval inbox binding. The actions route calls the precheck BEFORE recording
// an approve (so SoD is enforced there too) and the outcome hook AFTER.
// ---------------------------------------------------------------------------

async function matchByApprovalRequest(tenantId: number, requestId: number) {
  await ensureMatchSchema()
  const rows = (await query(`SELECT * FROM finance_match_results WHERE tenant_id = ? AND approval_request_id = ? LIMIT 1`, [
    tenantId,
    requestId,
  ])) as any[]
  return rows[0] ?? null
}

export async function precheckMatchApprovalAction(requestId: number, actorId: number, action: string): Promise<string | null> {
  if (action !== "approve") return null
  const tenantId = await getTenantId()
  if (tenantId == null) return null
  const row = await matchByApprovalRequest(Number(tenantId), requestId)
  if (!row) return null
  return checkResolveSod(Number(tenantId), s(row.bill_id), s(row.po_number), actorId)
}

export async function handleMatchApprovalOutcome(
  requestId: number,
  status: string,
  who: { id: number; name: string | null },
): Promise<void> {
  if (status !== "approved" && status !== "rejected") return
  const tenantId = await getTenantId()
  if (tenantId == null) return
  const row = await matchByApprovalRequest(Number(tenantId), requestId)
  if (!row) return
  await resolveMatchException(Number(tenantId), s(row.bill_id), status === "approved" ? "approve" : "reject", {
    userId: who.id,
    userName: who.name,
    note: `Decided in approval inbox (request #${requestId}).`,
    viaApprovalRequest: requestId,
  })
}

// ---------------------------------------------------------------------------
// Payment hold — called by the purchase-bill guard when payment increases.
// Recomputes the match live (so it cannot be bypassed) and blocks payment when
// an exception is open. An approved override for the same exception set releases it.
// ---------------------------------------------------------------------------

export async function evaluateBillPaymentHold(
  tenantId: number,
  bill: BillRow,
  opts?: { billQuantity?: unknown },
): Promise<string | null> {
  if (!(await tableExists("procurement_purchase_orders"))) return null
  const poRef = s(bill.po_number)
  if (!poRef) return null
  const po = await findPo(tenantId, poRef)
  if (!po) return null // free-text / legacy PO reference — nothing to match

  const tol = await getMatchTolerances(tenantId)
  const { input } = await gatherMatchInput(tenantId, bill, opts)
  const result = evaluateThreeWayMatch(input, tol)
  if (!result.paymentHold) return null

  const billId = s(bill.bill_id)
  if (billId) {
    const rows = (await query(
      `SELECT resolution_status, resolved_categories FROM finance_match_results WHERE tenant_id = ? AND bill_id = ? LIMIT 1`,
      [tenantId, billId],
    )) as any[]
    if (rows[0]?.resolution_status === "approved" && sameSet(parseList(rows[0].resolved_categories), result.categories)) {
      return null
    }
  }
  return `Payment held by three-way match: ${summarizeMatch(result)}. An authorised checker must approve the exception before payment.`
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function safeParse(v: unknown): any {
  if (v == null) return null
  if (typeof v === "object") return v
  try {
    return JSON.parse(String(v))
  } catch {
    return null
  }
}

function parseList(v: unknown): string[] {
  const parsed = safeParse(v)
  return Array.isArray(parsed) ? parsed.map(String) : []
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sb = new Set(b)
  return a.every((x) => sb.has(x))
}

function toPersisted(row: Record<string, any>): PersistedMatch {
  const evidence = (safeParse(row.evidence) as MatchResult) ?? {
    status: "exception",
    paymentHold: !!num(row.payment_hold),
    variances: [],
    exceptions: [],
    categories: parseList(row.categories),
  }
  return {
    id: row.id != null ? Number(row.id) : null,
    billId: s(row.bill_id),
    billNumber: row.bill_number != null ? s(row.bill_number) : null,
    poNumber: row.po_number != null ? s(row.po_number) : null,
    grnNumber: row.grn_number != null ? s(row.grn_number) : null,
    vendorName: row.vendor_name != null ? s(row.vendor_name) : null,
    status: (s(row.match_status) as MatchResult["status"]) || "exception",
    paymentHold: !!num(row.payment_hold),
    resolutionStatus: (s(row.resolution_status) as ResolutionStatus) || "open",
    categories: parseList(row.categories),
    resolvedCategories: parseList(row.resolved_categories),
    resolvedBy: row.resolved_by != null ? Number(row.resolved_by) : null,
    resolvedByName: row.resolved_by_name != null ? s(row.resolved_by_name) : null,
    resolvedAt: row.resolved_at != null ? String(row.resolved_at) : null,
    resolutionNote: row.resolution_note != null ? s(row.resolution_note) : null,
    approvalRequestId: row.approval_request_id != null ? Number(row.approval_request_id) : null,
    billedTaxable: num(row.billed_taxable),
    computedAt: row.computed_at != null ? String(row.computed_at) : null,
    evidence,
    summary: summarizeMatch(evidence),
  }
}
