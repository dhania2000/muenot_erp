import "server-only"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { getTenantId } from "@/lib/api-auth"
import { logFinanceEvent } from "@/lib/finance-audit"
import { num, round2 } from "@/lib/finance-calc"
import {
  evaluateThreeWayMatch,
  normalizeTolerances,
  summarizeMatch,
  DEFAULT_TOLERANCES,
  type MatchTolerances,
  type MatchResult,
  type MatchInput,
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
 * Reuses the Spec36 procurement tables and the existing purchase_bills master;
 * it never duplicates the order / receipt / invoice subsystems.
 */

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
// database/migrations/2027-01-30-spec37-three-way-matching.sql for managed deploys.
// ---------------------------------------------------------------------------

let schemaEnsured = false

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

  schemaEnsured = true
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
): Promise<MatchTolerances> {
  await ensureMatchSchema()
  const tol = normalizeTolerances(raw)
  await query(
    `INSERT INTO finance_match_config (tenant_id, quantity_percent, price_percent, amount_percent, amount_absolute, updated_by)
       VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE quantity_percent = VALUES(quantity_percent), price_percent = VALUES(price_percent),
       amount_percent = VALUES(amount_percent), amount_absolute = VALUES(amount_absolute), updated_by = VALUES(updated_by)`,
    [tenantId, tol.quantityPercent, tol.pricePercent, tol.amountPercent, tol.amountAbsolute, userId],
  )
  await logFinanceEvent({
    entityType: "finance_match_config",
    entityRef: String(tenantId),
    type: "updated",
    summary: "Three-way match tolerances updated",
    detail: tol as unknown as Record<string, unknown>,
    actorId: userId,
  })
  return tol
}

// ---------------------------------------------------------------------------
// Gather the three documents for a bill — tenant-scoped, server-authoritative.
// ---------------------------------------------------------------------------

type BillRow = {
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
    `SELECT po_number, quantity, unit_price, discount_percent, taxable_amount, gst_rate, currency, vendor_id, vendor_name
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

async function grnAggregate(tenantId: number, poRef: string) {
  const rows = (await query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(accepted_quantity),0) AS qty, COALESCE(SUM(received_value),0) AS val
       FROM procurement_goods_receipts WHERE tenant_id = ? AND po_number = ?`,
    [tenantId, poRef],
  )) as any[]
  return { count: num(rows[0]?.n), acceptedQuantity: num(rows[0]?.qty), receivedValue: num(rows[0]?.val) }
}

async function otherBillsForPo(poRef: string, excludeBillId: string) {
  try {
    const rows = (await query(
      `SELECT COALESCE(SUM(taxable_amount),0) AS taxable, COALESCE(SUM(quantity),0) AS qty
         FROM purchase_bills WHERE po_number = ? AND bill_id <> ?`,
      [poRef, excludeBillId || "__none__"],
    )) as any[]
    return { taxable: num(rows[0]?.taxable), quantity: num(rows[0]?.qty) }
  } catch {
    return { taxable: 0, quantity: 0 }
  }
}

async function isDuplicateBill(bill: BillRow, excludeBillId: string): Promise<boolean> {
  const billNumber = s(bill.bill_number)
  const vendorId = s(bill.vendor_id)
  if (!billNumber || !vendorId) return false
  try {
    const rows = (await query(
      `SELECT COUNT(*) AS n FROM purchase_bills WHERE bill_number = ? AND vendor_id = ? AND bill_id <> ?`,
      [billNumber, vendorId, excludeBillId || "__none__"],
    )) as any[]
    return num(rows[0]?.n) > 0
  } catch {
    return false
  }
}

/**
 * Build the pure-engine input for a bill from the tenant's PO, goods receipts
 * and sibling bills. The bill's own billable quantity is derived from its
 * taxable value at the PO net price when the bill carries no quantity column.
 */
export async function gatherMatchInput(
  tenantId: number,
  bill: BillRow,
  opts?: { billQuantity?: unknown },
): Promise<{ input: MatchInput; po: Record<string, any> | null; poRef: string }> {
  const poRef = s(bill.po_number)
  const po = await findPo(tenantId, poRef)
  const excludeBillId = s(bill.bill_id)

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
        billTaxable: bill.taxable_amount,
        billGstRate: bill.gst_rate,
        billCurrency: bill.currency,
      },
      po: null,
      poRef,
    }
  }

  const grn = await grnAggregate(tenantId, poRef)
  const others = await otherBillsForPo(poRef, excludeBillId)
  const duplicate = await isDuplicateBill(bill, excludeBillId)
  const poUnit = netUnitPrice(po)
  const billTaxable = round2(num(bill.taxable_amount))
  const billQty = opts?.billQuantity != null && s(opts.billQuantity) !== ""
    ? num(opts.billQuantity)
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
      grnCount: grn.count,
      acceptedQuantity: grn.acceptedQuantity,
      receivedValue: grn.receivedValue,
      billedQuantity: billQty,
      billUnitPrice: billUnit,
      billTaxable,
      billCurrency: bill.currency ?? po.currency,
      billGstRate: bill.gst_rate,
      otherBilledQuantity: others.quantity,
      otherBilledTaxable: others.taxable,
      duplicateBill: duplicate,
    },
    po,
    poRef,
  }
}

// ---------------------------------------------------------------------------
// Compute + persist. A recompute that lands on the same status/categories does
// not disturb an existing checker resolution; a recompute that changes the
// exception set reopens the hold so a stale approval can never release payment.
// ---------------------------------------------------------------------------

export type PersistedMatch = {
  billId: string
  poNumber: string | null
  grnNumber: string | null
  vendorName: string | null
  status: MatchResult["status"]
  paymentHold: boolean
  resolutionStatus: "open" | "approved" | "rejected"
  categories: string[]
  resolvedCategories: string[]
  resolvedBy: number | null
  resolvedByName: string | null
  resolvedAt: string | null
  resolutionNote: string | null
  evidence: MatchResult
  summary: string
}

export async function computeAndPersistMatch(
  tenantId: number,
  bill: BillRow,
  opts?: { billQuantity?: unknown; userId?: number | null },
): Promise<PersistedMatch> {
  await ensureMatchSchema()
  const billId = s(bill.bill_id)
  if (!billId) throw new Error("A bill id is required to run three-way matching.")

  const tol = await getMatchTolerances(tenantId)
  const { input, poRef } = await gatherMatchInput(tenantId, bill, opts)
  const result = evaluateThreeWayMatch(input, tol)
  const categories = result.categories
  const userId = opts?.userId ?? (await actor()).id

  const existing = (await query(
    `SELECT match_status, categories, resolution_status, resolved_categories FROM finance_match_results
       WHERE tenant_id = ? AND bill_id = ? LIMIT 1`,
    [tenantId, billId],
  )) as any[]
  const prev = existing[0] ?? null

  // Keep a prior approval only when the exact same exception set is still open.
  const prevResolved = parseList(prev?.resolved_categories)
  const sameExceptionSet =
    prev?.resolution_status === "approved" && sameSet(prevResolved, categories) && categories.length > 0
  const resolutionStatus: "open" | "approved" | "rejected" = sameExceptionSet ? "approved" : "open"
  const effectiveHold = result.paymentHold && resolutionStatus !== "approved"

  await query(
    `INSERT INTO finance_match_results
       (tenant_id, bill_id, po_number, grn_number, vendor_name, match_status, payment_hold, categories, evidence,
        resolution_status, resolved_categories, computed_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       po_number = VALUES(po_number), grn_number = VALUES(grn_number), vendor_name = VALUES(vendor_name),
       match_status = VALUES(match_status), payment_hold = VALUES(payment_hold), categories = VALUES(categories),
       evidence = VALUES(evidence), resolution_status = VALUES(resolution_status),
       resolved_categories = IF(VALUES(resolution_status) = 'approved', resolved_categories, NULL),
       resolved_by = IF(VALUES(resolution_status) = 'approved', resolved_by, NULL),
       resolved_by_name = IF(VALUES(resolution_status) = 'approved', resolved_by_name, NULL),
       resolved_at = IF(VALUES(resolution_status) = 'approved', resolved_at, NULL),
       resolution_note = IF(VALUES(resolution_status) = 'approved', resolution_note, NULL),
       computed_by = VALUES(computed_by)`,
    [
      tenantId,
      billId,
      poRef || null,
      s(bill.grn_number) || null,
      s(bill.vendor_name) || null,
      result.status,
      effectiveHold ? 1 : 0,
      JSON.stringify(categories),
      JSON.stringify(result),
      resolutionStatus,
      sameExceptionSet ? JSON.stringify(prevResolved) : null,
      userId,
    ],
  )

  // Audit only a genuine change in the match outcome — a plain recompute is silent.
  const changed = !prev || s(prev.match_status) !== result.status || !sameSet(parseList(prev.categories), categories)
  if (changed) {
    await logFinanceEvent({
      entityType: "finance_match_result",
      entityRef: billId,
      type: "updated",
      summary: `Three-way match ${billId}: ${summarizeMatch(result)}`,
      detail: { poNumber: poRef, status: result.status, categories },
      actorId: userId,
    })
  }

  return toPersisted({
    tenant_id: tenantId,
    bill_id: billId,
    po_number: poRef || null,
    grn_number: s(bill.grn_number) || null,
    vendor_name: s(bill.vendor_name) || null,
    match_status: result.status,
    payment_hold: effectiveHold ? 1 : 0,
    categories: JSON.stringify(categories),
    evidence: JSON.stringify(result),
    resolution_status: resolutionStatus,
    resolved_categories: sameExceptionSet ? JSON.stringify(prevResolved) : null,
    resolved_by: null,
    resolved_by_name: null,
    resolved_at: null,
    resolution_note: null,
  })
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

export async function getMatchForBill(tenantId: number, billId: string): Promise<PersistedMatch | null> {
  await ensureMatchSchema()
  const rows = (await query(`SELECT * FROM finance_match_results WHERE tenant_id = ? AND bill_id = ? LIMIT 1`, [tenantId, billId])) as any[]
  return rows[0] ? toPersisted(rows[0]) : null
}

export async function listMatches(
  tenantId: number,
  filter?: { status?: string; holdOnly?: boolean },
): Promise<PersistedMatch[]> {
  await ensureMatchSchema()
  const where: string[] = ["tenant_id = ?"]
  const args: unknown[] = [tenantId]
  if (filter?.status && filter.status !== "all") {
    where.push("match_status = ?")
    args.push(filter.status)
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
  | { ok: true; match: PersistedMatch }
  | { ok: false; status: number; error: string }

export async function resolveMatchException(
  tenantId: number,
  billId: string,
  decision: "approve" | "reject",
  opts: { userId: number; userName: string | null; note?: string | null },
): Promise<ResolveOutcome> {
  await ensureMatchSchema()
  const rows = (await query(`SELECT * FROM finance_match_results WHERE tenant_id = ? AND bill_id = ? LIMIT 1`, [tenantId, billId])) as any[]
  const row = rows[0]
  if (!row) return { ok: false, status: 404, error: "No three-way match record exists for this bill." }
  if (s(row.match_status) !== "exception") {
    return { ok: false, status: 409, error: "This match has no exception to resolve." }
  }
  if (s(row.resolution_status) === "approved" && decision === "approve") {
    return { ok: true, match: toPersisted(row) }
  }

  // Segregation of duties against the bill creator and the PO approver.
  const sod = await checkResolveSod(tenantId, billId, s(row.po_number), opts.userId)
  if (sod) return { ok: false, status: 403, error: sod }

  const approve = decision === "approve"
  await query(
    `UPDATE finance_match_results
       SET resolution_status = ?, payment_hold = ?, resolution_note = ?, resolved_by = ?, resolved_by_name = ?,
           resolved_at = NOW(), resolved_categories = ?
     WHERE tenant_id = ? AND bill_id = ?`,
    [
      approve ? "approved" : "rejected",
      approve ? 0 : 1,
      s(opts.note) || null,
      opts.userId,
      opts.userName,
      approve ? row.categories : null,
      tenantId,
      billId,
    ],
  )

  await logFinanceEvent({
    entityType: "finance_match_result",
    entityRef: billId,
    type: approve ? "approved" : "rejected",
    summary: `Three-way match exception ${approve ? "approved" : "rejected"} for ${billId}${opts.note ? ` — ${s(opts.note)}` : ""}`,
    detail: {
      poNumber: s(row.po_number),
      categories: parseList(row.categories),
      decision,
      note: s(opts.note) || null,
      evidence: safeParse(row.evidence),
    },
    actorId: opts.userId,
    actorName: opts.userName,
  })

  const fresh = (await query(`SELECT * FROM finance_match_results WHERE tenant_id = ? AND bill_id = ? LIMIT 1`, [tenantId, billId])) as any[]
  return { ok: true, match: toPersisted(fresh[0]) }
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

  // An open exception holds payment unless an authorised checker approved the
  // exact same exception set on the persisted record.
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
    billId: s(row.bill_id),
    poNumber: row.po_number != null ? s(row.po_number) : null,
    grnNumber: row.grn_number != null ? s(row.grn_number) : null,
    vendorName: row.vendor_name != null ? s(row.vendor_name) : null,
    status: (s(row.match_status) as MatchResult["status"]) || "exception",
    paymentHold: !!num(row.payment_hold),
    resolutionStatus: (s(row.resolution_status) as PersistedMatch["resolutionStatus"]) || "open",
    categories: parseList(row.categories),
    resolvedCategories: parseList(row.resolved_categories),
    resolvedBy: row.resolved_by != null ? Number(row.resolved_by) : null,
    resolvedByName: row.resolved_by_name != null ? s(row.resolved_by_name) : null,
    resolvedAt: row.resolved_at != null ? String(row.resolved_at) : null,
    resolutionNote: row.resolution_note != null ? s(row.resolution_note) : null,
    evidence,
    summary: summarizeMatch(evidence),
  }
}
