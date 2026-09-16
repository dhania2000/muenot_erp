import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { ensureRegisterModuleTables } from "@/lib/finance-ensure"

export const dynamic = "force-dynamic"

/**
 * Phase 8 — automatic identification of related-party transactions.
 *
 * Rather than creating a new financial report, this endpoint scans the existing
 * Finance transaction tables (purchase bills, expenses, sales invoices,
 * payments) and returns only the rows whose counterparty resolves to a party in
 * the `related_parties` master. Matching is done on any of the strong
 * identifiers captured on the related party — the linked master id, PAN, GSTIN —
 * and falls back to a case-insensitive name match. A transaction is only
 * attributed when its date sits inside the party's effective window (when set).
 */

type Party = {
  party_id: string
  party_name: string
  relationship: string | null
  source_type: string | null
  source_id: string | null
  pan: string | null
  gstin: string | null
  effective_from: string | null
  effective_to: string | null
}

type Txn = {
  source: string
  doc_type: string
  reference: string
  txn_date: string | null
  amount: number
  counterparty: string
  party_id: string
  party_name: string
  relationship: string | null
  match_basis: string
}

const norm = (v: any) => String(v ?? "").trim().toLowerCase()
const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

async function safeRows(sql: string, params: any[] = []): Promise<any[]> {
  try {
    const rows = await query<any[]>(sql, params)
    return rows || []
  } catch {
    return []
  }
}

/** Indexes the related-party master for O(1) lookups by each identifier. */
function buildIndex(parties: Party[]) {
  const byId = new Map<string, Party>()
  const byPan = new Map<string, Party>()
  const byGstin = new Map<string, Party>()
  const byName = new Map<string, Party>()
  for (const p of parties) {
    if (p.source_id) byId.set(norm(p.source_id), p)
    if (p.pan) byPan.set(norm(p.pan), p)
    if (p.gstin) byGstin.set(norm(p.gstin), p)
    if (p.party_name) byName.set(norm(p.party_name), p)
  }
  return { byId, byPan, byGstin, byName }
}

type Index = ReturnType<typeof buildIndex>

/** Resolves a transaction's identifiers to a related party, id/PAN/GSTIN first. */
function match(
  idx: Index,
  ids: (string | null | undefined)[],
  pan: string | null | undefined,
  gstin: string | null | undefined,
  name: string | null | undefined,
): { party: Party; basis: string } | null {
  for (const id of ids) {
    if (id && idx.byId.has(norm(id))) return { party: idx.byId.get(norm(id))!, basis: "Linked ID" }
  }
  if (pan && idx.byPan.has(norm(pan))) return { party: idx.byPan.get(norm(pan))!, basis: "PAN" }
  if (gstin && idx.byGstin.has(norm(gstin))) return { party: idx.byGstin.get(norm(gstin))!, basis: "GSTIN" }
  if (name && idx.byName.has(norm(name))) return { party: idx.byName.get(norm(name))!, basis: "Name" }
  return null
}

/** True when `date` is inside the party's effective window (open-ended when unset). */
function inWindow(party: Party, date: string | null): boolean {
  if (!date) return true
  const d = date.slice(0, 10)
  if (party.effective_from && d < String(party.effective_from).slice(0, 10)) return false
  if (party.effective_to && d > String(party.effective_to).slice(0, 10)) return false
  return true
}

export async function GET() {
  await ensureRegisterModuleTables()

  const parties = await safeRows(
    `SELECT party_id, party_name, relationship, source_type, source_id, pan, gstin, effective_from, effective_to
     FROM related_parties WHERE status = 'Active'`,
  )
  const list = parties as Party[]

  if (!list.length) {
    return NextResponse.json({ transactions: [], parties: [], summary: { count: 0, total: 0 } })
  }

  const idx = buildIndex(list)
  const txns: Txn[] = []

  const push = (
    hit: { party: Party; basis: string } | null,
    t: { source: string; doc_type: string; reference: string; txn_date: string | null; amount: number; counterparty: string },
  ) => {
    if (!hit) return
    if (!inWindow(hit.party, t.txn_date)) return
    txns.push({
      ...t,
      party_id: hit.party.party_id,
      party_name: hit.party.party_name,
      relationship: hit.party.relationship,
      match_basis: hit.basis,
    })
  }

  // Purchase bills — vendor dealings.
  for (const r of await safeRows(
    `SELECT bill_id, bill_date, gross_bill_amount, vendor_name, vendor_id, vendor_gstin, vendor_pan FROM purchase_bills`,
  )) {
    push(match(idx, [r.vendor_id], r.vendor_pan, r.vendor_gstin, r.vendor_name), {
      source: "purchase-bills",
      doc_type: "Purchase Bill",
      reference: String(r.bill_id ?? ""),
      txn_date: r.bill_date ? String(r.bill_date) : null,
      amount: num(r.gross_bill_amount),
      counterparty: String(r.vendor_name ?? ""),
    })
  }

  // Expenses — vendor + employee reimbursements.
  for (const r of await safeRows(
    `SELECT id, expense_date, gross_amount, party_name, vendor_id, employee_id, vendor_gstin, vendor_pan FROM expenses`,
  )) {
    push(match(idx, [r.vendor_id, r.employee_id], r.vendor_pan, r.vendor_gstin, r.party_name), {
      source: "expenses",
      doc_type: "Expense",
      reference: String(r.id ?? ""),
      txn_date: r.expense_date ? String(r.expense_date) : null,
      amount: num(r.gross_amount),
      counterparty: String(r.party_name ?? ""),
    })
  }

  // Sales invoices — customer dealings (matched by client name / linked id).
  for (const r of await safeRows(
    `SELECT invoice_id, invoice_date, invoice_total, client_name, client_id, client_pan, client_gstin FROM sales_invoices`,
  )) {
    push(match(idx, [r.client_id], r.client_pan, r.client_gstin, r.client_name), {
      source: "sales-invoices",
      doc_type: "Sales Invoice",
      reference: String(r.invoice_id ?? ""),
      txn_date: r.invoice_date ? String(r.invoice_date) : null,
      amount: num(r.invoice_total),
      counterparty: String(r.client_name ?? ""),
    })
  }

  // Payments — settlements to / from any party.
  for (const r of await safeRows(
    `SELECT id, party_id, party_name, payment_date, amount, reference_no FROM payments`,
  )) {
    push(match(idx, [r.party_id], null, null, r.party_name), {
      source: "payments",
      doc_type: "Payment",
      reference: String(r.reference_no || r.id || ""),
      txn_date: r.payment_date ? String(r.payment_date) : null,
      amount: num(r.amount),
      counterparty: String(r.party_name ?? ""),
    })
  }

  txns.sort((a, b) => (b.txn_date || "").localeCompare(a.txn_date || ""))

  const partySummaries = list
    .map((p) => {
      const rows = txns.filter((t) => t.party_id === p.party_id)
      return {
        party_id: p.party_id,
        party_name: p.party_name,
        relationship: p.relationship,
        count: rows.length,
        total: rows.reduce((s, t) => s + t.amount, 0),
      }
    })
    .sort((a, b) => b.total - a.total)

  return NextResponse.json({
    transactions: txns,
    parties: partySummaries,
    summary: { count: txns.length, total: txns.reduce((s, t) => s + t.amount, 0) },
  })
}
