import "server-only"
import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { logFinanceEvent } from "@/lib/finance-audit"
import { tdsDetail } from "@/lib/finance-tds-filing"
import { monthsOfFy, quarterOfPeriod } from "@/lib/finance-tds-compliance"
import { listCertificates } from "@/lib/finance-tds-compliance"

/**
 * TDS Receivable ledger (Phase 49–50) — the credit side of TDS.
 *
 * When our CUSTOMERS deduct TDS on what they pay us it is not a liability we
 * deposit; it is a credit we must collect back (as a Form 16A certificate /
 * Form 26AS entry) and adjust against our advance tax. The *deducted* amount is
 * already derived, per sales invoice, by the filing engine (`tdsDetail` in the
 * "receivable" direction) — we never re-capture it here. This module only adds
 * the receipt/adjustment side that the derived engine has no source for:
 *
 *   TDS Receivable  = Σ tds deducted by customers on our invoices  (derived)
 *   Received / Adjusted = credits actually recovered or set off     (persisted)
 *   Outstanding     = Receivable − Received − Adjusted              (computed)
 *
 * A receipt carries the source module + source transaction id of the invoice it
 * belongs to (Phase 43 traceability) and an optional customer certificate ref,
 * and is idempotent on an optional external key (Phase 46).
 */

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100
const FY_RE = /^\d{4}-\d{2}$/

export type ReceivableMode = "Received" | "Adjusted"
const normMode = (m: any): ReceivableMode => (String(m) === "Adjusted" ? "Adjusted" : "Received")

let ensured = false
export async function ensureReceivableSchema() {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS tds_receivable_receipts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      receipt_id VARCHAR(40) NOT NULL,
      financial_year VARCHAR(12) NOT NULL,
      party_id VARCHAR(60) DEFAULT NULL,
      party_name VARCHAR(190) DEFAULT NULL,
      pan VARCHAR(20) DEFAULT NULL,
      section VARCHAR(20) DEFAULT NULL,
      source_module VARCHAR(40) DEFAULT NULL,      -- e.g. 'Sales Invoice'
      source_txn_id VARCHAR(60) DEFAULT NULL,      -- the invoice id this credit settles
      invoice_ref VARCHAR(80) DEFAULT NULL,
      mode VARCHAR(12) NOT NULL DEFAULT 'Received', -- Received / Adjusted
      amount DECIMAL(16,2) NOT NULL DEFAULT 0,
      receipt_date DATE DEFAULT NULL,
      certificate_ref VARCHAR(80) DEFAULT NULL,     -- customer's Form 16A / 26AS ref
      note VARCHAR(255) DEFAULT NULL,
      idempotency_key VARCHAR(120) DEFAULT NULL,
      created_by BIGINT UNSIGNED DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_recv_receipt_id (receipt_id),
      UNIQUE KEY uq_recv_idem (idempotency_key),
      KEY idx_recv_fy (financial_year),
      KEY idx_recv_party (party_id),
      KEY idx_recv_txn (source_txn_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  ensured = true
}

export type ReceivableReceipt = {
  id: number
  receipt_id: string
  financial_year: string
  party_id: string | null
  party_name: string | null
  pan: string | null
  section: string | null
  source_module: string | null
  source_txn_id: string | null
  invoice_ref: string | null
  mode: ReceivableMode
  amount: number
  receipt_date: string | null
  certificate_ref: string | null
  note: string | null
}

function mapReceipt(r: any): ReceivableReceipt {
  return {
    id: Number(r.id),
    receipt_id: r.receipt_id,
    financial_year: r.financial_year,
    party_id: r.party_id ?? null,
    party_name: r.party_name ?? null,
    pan: r.pan ?? null,
    section: r.section ?? null,
    source_module: r.source_module ?? null,
    source_txn_id: r.source_txn_id ?? null,
    invoice_ref: r.invoice_ref ?? null,
    mode: normMode(r.mode),
    amount: round2(num(r.amount)),
    receipt_date: r.receipt_date ? String(r.receipt_date).slice(0, 10) : null,
    certificate_ref: r.certificate_ref ?? null,
    note: r.note ?? null,
  }
}

export async function listReceivableReceipts(financialYear?: string): Promise<ReceivableReceipt[]> {
  await ensureReceivableSchema()
  const rows = (await query(
    `SELECT * FROM tds_receivable_receipts
       ${financialYear ? "WHERE financial_year = ?" : ""}
       ORDER BY receipt_date DESC, id DESC LIMIT 500`,
    financialYear ? [financialYear] : [],
  ).catch(() => [])) as any[]
  return rows.map(mapReceipt)
}

/**
 * Record a TDS-receivable credit as received or adjusted against a customer's
 * deducted TDS. Idempotent when an `idempotencyKey` is supplied — a repeated
 * sync of the same external credit returns the existing receipt instead of
 * duplicating it (Phase 46).
 */
export async function recordReceivableReceipt(input: {
  financialYear: string
  partyId?: string | null
  partyName?: string | null
  pan?: string | null
  section?: string | null
  sourceModule?: string | null
  sourceTxnId?: string | null
  invoiceRef?: string | null
  mode?: ReceivableMode
  amount: number
  receiptDate?: string | null
  certificateRef?: string | null
  note?: string | null
  idempotencyKey?: string | null
  actorId?: number | null
}): Promise<{ receipt_id: string; deduplicated: boolean }> {
  await ensureReceivableSchema()
  if (!FY_RE.test(input.financialYear)) throw new Error("Financial year must be in YYYY-YY format.")
  const amount = round2(input.amount)
  if (!(amount > 0)) throw new Error("Credit amount must be greater than zero.")

  if (input.idempotencyKey) {
    const [dup] = (await query(
      `SELECT receipt_id FROM tds_receivable_receipts WHERE idempotency_key = ? LIMIT 1`,
      [input.idempotencyKey],
    ).catch(() => [])) as any[]
    if (dup) return { receipt_id: dup.receipt_id, deduplicated: true }
  }

  const receiptId = await nextRecordId("TRR")
  await query(
    `INSERT INTO tds_receivable_receipts
       (receipt_id, financial_year, party_id, party_name, pan, section, source_module, source_txn_id,
        invoice_ref, mode, amount, receipt_date, certificate_ref, note, idempotency_key, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      receiptId, input.financialYear, input.partyId || null, input.partyName || null, input.pan || null,
      input.section || null, input.sourceModule || "Sales Invoice", input.sourceTxnId || null,
      input.invoiceRef || null, normMode(input.mode), amount, input.receiptDate || null,
      input.certificateRef || null, input.note || null, input.idempotencyKey || null, input.actorId ?? null,
    ],
  )
  await logFinanceEvent({
    entityType: "tds_receivable_receipt",
    entityRef: receiptId,
    type: "payment_recorded",
    summary: `TDS receivable ${normMode(input.mode)} ${amount} for ${input.partyName || input.partyId || "customer"}`,
    amount,
    actorId: input.actorId ?? null,
  }).catch(() => {})
  return { receipt_id: receiptId, deduplicated: false }
}

export async function deleteReceivableReceipt(receiptId: string, actorId?: number | null) {
  await ensureReceivableSchema()
  const res = (await query(`DELETE FROM tds_receivable_receipts WHERE receipt_id = ?`, [receiptId]).catch(
    () => null,
  )) as any
  if (!res || Number(res.affectedRows || 0) === 0) throw new Error("Receipt not found.")
  await logFinanceEvent({
    entityType: "tds_receivable_receipt",
    entityRef: receiptId,
    type: "deleted",
    summary: `Deleted TDS receivable receipt ${receiptId}`,
    actorId: actorId ?? null,
  }).catch(() => {})
  return { ok: true }
}

/** Best-effort customer PAN lookup from the single customer/vendor master. */
async function customerPanMap(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const clean = Array.from(new Set(ids.filter((v) => v && v !== "—")))
  if (clean.length === 0) return map
  const placeholders = clean.map(() => "?").join(",")
  const rows = (await query(
    `SELECT party_id, pan FROM customers_vendors WHERE party_id IN (${placeholders})`,
    clean,
  ).catch(() => [])) as any[]
  for (const r of rows) if (r.pan) map.set(String(r.party_id), String(r.pan).toUpperCase())
  return map
}

export type CustomerTdsRow = {
  party_id: string
  customer: string
  invoice_id: string
  invoice_ref: string
  source_module: string
  invoice_date: string
  quarter: string
  pan: string
  section: string
  base: number
  tds: number
  received: number
  adjusted: number
  outstanding: number
  certificate_ref: string | null
  status: "Received" | "Adjusted" | "Partially Received" | "Outstanding"
}

/**
 * Invoice-level customer TDS ledger for a financial year (Phase 50). One row per
 * sales invoice that carried TDS, joined to any receipts recorded against it, so
 * every customer credit shows Base / TDS / Received / Outstanding / Certificate.
 */
export async function tdsReceivableLedger(financialYear: string) {
  await ensureReceivableSchema()
  if (!FY_RE.test(financialYear)) throw new Error("Financial year must be in YYYY-YY format.")

  const months = monthsOfFy(financialYear)
  let detail: any[] = []
  for (const p of months) detail = detail.concat(await tdsDetail(p, "receivable"))

  const receipts = await listReceivableReceipts(financialYear)
  // Index receipts by the invoice (source txn) they settle.
  const byInvoice = new Map<string, { received: number; adjusted: number; certs: Set<string> }>()
  for (const r of receipts) {
    const key = String(r.source_txn_id || r.invoice_ref || "")
    if (!key) continue
    const e = byInvoice.get(key) || { received: 0, adjusted: 0, certs: new Set<string>() }
    if (r.mode === "Adjusted") e.adjusted = round2(e.adjusted + r.amount)
    else e.received = round2(e.received + r.amount)
    if (r.certificate_ref) e.certs.add(r.certificate_ref)
    byInvoice.set(key, e)
  }

  const panMap = await customerPanMap(detail.map((r) => String(r.party_id || "")))

  const rows: CustomerTdsRow[] = detail.map((r) => {
    const invoiceId = String(r.doc_id || "")
    const tds = round2(num(r.tds))
    const rec = byInvoice.get(invoiceId) || { received: 0, adjusted: 0, certs: new Set<string>() }
    const received = round2(rec.received)
    const adjusted = round2(rec.adjusted)
    const outstanding = round2(Math.max(0, tds - received - adjusted))
    const settled = received + adjusted
    let status: CustomerTdsRow["status"] = "Outstanding"
    if (settled >= tds - 0.01) status = adjusted > received ? "Adjusted" : "Received"
    else if (settled > 0) status = "Partially Received"
    const period = String(r.doc_date).slice(0, 7)
    return {
      party_id: String(r.party_id || ""),
      customer: r.party_name || "—",
      invoice_id: invoiceId,
      invoice_ref: String(r.doc_ref || invoiceId),
      source_module: r.source || "Sales Invoice",
      invoice_date: String(r.doc_date).slice(0, 10),
      quarter: quarterOfPeriod(period),
      pan: panMap.get(String(r.party_id || "")) || "",
      section: r.section || "Unspecified",
      base: round2(num(r.base)),
      tds,
      received,
      adjusted,
      outstanding,
      certificate_ref: rec.certs.size ? Array.from(rec.certs).join(", ") : null,
      status,
    }
  })

  rows.sort((a, b) => b.outstanding - a.outstanding || b.tds - a.tds)

  // Customer rollup (Phase 50 header view).
  const custMap = new Map<string, { party_id: string; customer: string; pan: string; base: number; tds: number; received: number; adjusted: number; outstanding: number; invoices: number }>()
  for (const r of rows) {
    const key = r.party_id || r.customer
    const e = custMap.get(key) || {
      party_id: r.party_id, customer: r.customer, pan: r.pan, base: 0, tds: 0, received: 0, adjusted: 0, outstanding: 0, invoices: 0,
    }
    e.base = round2(e.base + r.base)
    e.tds = round2(e.tds + r.tds)
    e.received = round2(e.received + r.received)
    e.adjusted = round2(e.adjusted + r.adjusted)
    e.outstanding = round2(e.outstanding + r.outstanding)
    e.invoices += 1
    if (!e.pan && r.pan) e.pan = r.pan
    custMap.set(key, e)
  }
  const customers = Array.from(custMap.values()).sort((a, b) => b.outstanding - a.outstanding)

  const totals = {
    receivable: round2(rows.reduce((s, r) => s + r.tds, 0)),
    received: round2(rows.reduce((s, r) => s + r.received, 0)),
    adjusted: round2(rows.reduce((s, r) => s + r.adjusted, 0)),
    outstanding: round2(rows.reduce((s, r) => s + r.outstanding, 0)),
    invoice_count: rows.length,
    customer_count: customers.length,
  }

  return { financial_year: financialYear, rows, customers, totals }
}
