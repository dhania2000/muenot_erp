import type { PoolConnection } from "mysql2/promise"
import { pool } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { resolveAccount, isDebitNature, type AccountRole, type ResolvedAccount } from "@/lib/finance-accounts"

// ---------------------------------------------------------------------------
// Double-entry posting engine (server-only).
//
// Turns a completed source document (Phase 1: a Sales Invoice) into a balanced
// set of journal_entries lines and the matching general_ledger rows, all inside
// a single database transaction. Money never comes from the browser — the
// engine reads the server-authoritative totals already stored on the invoice.
//
// A voucher groups the lines: journal_entry_id stays unique per line, voucher_no
// (VCH-####) ties the debits and credits of one posting together and is written
// back onto the source document so it can be re-found and never double-posted.
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

type PostingLine = {
  role: AccountRole
  debit: number
  credit: number
  /** portion of this line that is tax, for GST/TDS reporting on the row */
  gst?: number
  tds?: number
}

export type PostingResult = {
  voucherNo: string
  journalEntryIds: string[]
  ledgerIds: string[]
  totalDebit: number
  totalCredit: number
}

/**
 * Build the balanced posting lines for a sales invoice from its stored totals.
 *
 *   Dr Accounts Receivable   net_receivable          (invoice_total − TDS)
 *   Dr TDS Receivable         tds_amount              (only when TDS applies)
 *   Cr Sales Revenue          taxable_amount
 *   Cr Output CGST/SGST/IGST  respective tax amounts
 *   Cr Output Cess            other_tax_cess
 */
export function buildSalesInvoiceLines(inv: Record<string, any>): PostingLine[] {
  const taxable = round2(num(inv.taxable_amount))
  const cgst = round2(num(inv.cgst_amount))
  const sgst = round2(num(inv.sgst_amount))
  const igst = round2(num(inv.igst_amount))
  const cess = round2(num(inv.other_tax_cess))
  const tds = round2(num(inv.tds_amount))
  const total = round2(num(inv.invoice_total))
  const receivable = round2(total - tds)

  const lines: PostingLine[] = []
  if (receivable !== 0) lines.push({ role: "receivable", debit: receivable, credit: 0 })
  if (tds > 0) lines.push({ role: "tds_receivable", debit: tds, credit: 0, tds })
  if (taxable !== 0) lines.push({ role: "sales", debit: 0, credit: taxable })
  if (cgst > 0) lines.push({ role: "output_cgst", debit: 0, credit: cgst, gst: cgst })
  if (sgst > 0) lines.push({ role: "output_sgst", debit: 0, credit: sgst, gst: sgst })
  if (igst > 0) lines.push({ role: "output_igst", debit: 0, credit: igst, gst: igst })
  if (cess > 0) lines.push({ role: "output_cess", debit: 0, credit: cess })
  return lines
}

function assertBalanced(lines: PostingLine[]) {
  const debit = round2(lines.reduce((s, l) => s + num(l.debit), 0))
  const credit = round2(lines.reduce((s, l) => s + num(l.credit), 0))
  if (Math.abs(debit - credit) > 0.01) {
    throw new Error(`Posting is not balanced: debit ${debit} ≠ credit ${credit}`)
  }
  if (debit === 0) throw new Error("Posting has no amounts")
  return { debit, credit }
}

/** Read the current signed running balance for an account (within the txn). */
async function currentSignedBalance(
  conn: PoolConnection,
  account: ResolvedAccount,
): Promise<number> {
  const [rows] = await conn.query<any[]>(
    `SELECT balance, balance_type FROM general_ledger
       WHERE account_id = ? ORDER BY id DESC LIMIT 1`,
    [account.account_id],
  )
  const last = rows?.[0]
  if (!last) return 0
  const naturalDebit = isDebitNature(account)
  const bal = num(last.balance)
  const onNatural = String(last.balance_type || "").toLowerCase() === (naturalDebit ? "debit" : "credit")
  return onNatural ? bal : -bal
}

type PostArgs = {
  entityType: string
  entityId: number
  entityRef: string
  date: string
  financialYear: string | null
  partyId?: string | null
  partyName?: string | null
  projectId?: string | null
  projectName?: string | null
  voucherType: string
  narration: string
  sourceModule: string
  createdBy?: number | null
  /** reverse=true flips every debit/credit — used to unwind a prior posting */
  reverse?: boolean
}

/**
 * Post a set of balanced lines to journal_entries + general_ledger inside one
 * transaction. Returns the voucher and the ids created. Throws (rolling back)
 * if anything is missing or unbalanced, so a posting is all-or-nothing.
 */
export async function postLines(lines: PostingLine[], args: PostArgs): Promise<PostingResult> {
  const oriented = args.reverse
    ? lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }))
    : lines
  const { debit, credit } = assertBalanced(oriented)

  // Resolve every account up front (outside the txn) so a missing account fails
  // before we open a transaction.
  const resolved = new Map<AccountRole, ResolvedAccount>()
  for (const line of oriented) {
    if (!resolved.has(line.role)) resolved.set(line.role, await resolveAccount(line.role))
  }

  const voucherNo = await nextRecordId("VCH")
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const journalEntryIds: string[] = []
    const ledgerIds: string[] = []

    for (const line of oriented) {
      const account = resolved.get(line.role)!
      const journalEntryId = await nextRecordId("JE")
      const ledgerId = await nextRecordId("GL")

      await conn.query(
        `INSERT INTO journal_entries
           (journal_entry_id, voucher_no, journal_date, financial_year, reference_type,
            reference_no, voucher_type, narration, account_id, account_name, account_group,
            account_type, party_id, party_name, project_id, project_name, debit, credit,
            net_amount, gst_amount, tds_amount, source_module, source_reference,
            source_entity_type, source_entity_id, approval_status, approved_by,
            posting_status, posting_date, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          journalEntryId, voucherNo, args.date, args.financialYear, "System",
          args.entityRef, args.voucherType, args.narration, account.account_id, account.account_name,
          account.account_group, account.account_type, args.partyId ?? null, args.partyName ?? null,
          args.projectId ?? null, args.projectName ?? null, round2(line.debit), round2(line.credit),
          round2(line.debit - line.credit), round2(line.gst ?? 0), round2(line.tds ?? 0),
          args.sourceModule, args.entityRef, args.entityType, args.entityId, "Approved", "System",
          "Posted", args.date, args.createdBy ?? null,
        ],
      )
      journalEntryIds.push(journalEntryId)

      // Running balance for the account, signed in its natural direction.
      const prev = await currentSignedBalance(conn, account)
      const naturalDebit = isDebitNature(account)
      const signedDelta = naturalDebit ? line.debit - line.credit : line.credit - line.debit
      const running = round2(prev + signedDelta)
      const balanceType = running >= 0 ? (naturalDebit ? "Debit" : "Credit") : naturalDebit ? "Credit" : "Debit"

      await conn.query(
        `INSERT INTO general_ledger
           (ledger_id, journal_entry_id, voucher_no, financial_year, transaction_date, value_date,
            account_id, account_name, account_group, account_type, transaction_type, voucher_type,
            reference_no, party_id, party_name, project_id, project_name, description, debit, credit,
            amount, gst_amount, tds_amount, balance, balance_type, source_module, source_reference,
            source_entity_type, source_entity_id, reconciliation_status, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          ledgerId, journalEntryId, voucherNo, args.financialYear, args.date, args.date,
          account.account_id, account.account_name, account.account_group, account.account_type,
          line.debit > 0 ? "Debit" : "Credit", args.voucherType, args.entityRef,
          args.partyId ?? null, args.partyName ?? null, args.projectId ?? null, args.projectName ?? null,
          args.narration, round2(line.debit), round2(line.credit), round2(line.debit - line.credit),
          round2(line.gst ?? 0), round2(line.tds ?? 0), Math.abs(running), balanceType,
          args.sourceModule, args.entityRef, args.entityType, args.entityId, "Unreconciled",
          args.createdBy ?? null,
        ],
      )
      ledgerIds.push(ledgerId)
    }

    await conn.commit()
    return { voucherNo, journalEntryIds, ledgerIds, totalDebit: debit, totalCredit: credit }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

/** Post a sales invoice from its stored (server-authoritative) totals. */
export async function postSalesInvoice(
  inv: Record<string, any>,
  opts: { createdBy?: number | null; reverse?: boolean } = {},
): Promise<PostingResult> {
  const lines = buildSalesInvoiceLines(inv)
  return postLines(lines, {
    entityType: "sales_invoice",
    entityId: Number(inv.id),
    entityRef: String(inv.invoice_id || inv.id),
    date: String(inv.invoice_date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    financialYear: inv.financial_year ?? null,
    partyId: inv.customer_party_id || inv.client_id || null,
    partyName: inv.client_name || null,
    projectId: inv.project_id || null,
    projectName: inv.project_name || null,
    voucherType: "Sales",
    narration: opts.reverse
      ? `Reversal of sales invoice ${inv.invoice_id || inv.id}`
      : `Sales invoice ${inv.invoice_id || inv.id}${inv.client_name ? ` — ${inv.client_name}` : ""}`,
    sourceModule: "Sales Invoice",
    createdBy: opts.createdBy ?? null,
    reverse: opts.reverse,
  })
}
