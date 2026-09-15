import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { financialYearFor } from "@/lib/finance-calc"
import {
  resolveAccount,
  resolveAccountById,
  isDebitNature,
  ensurePurchasePostingAccounts,
  type AccountRole,
  type ResolvedAccount,
} from "@/lib/finance-accounts"

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

/**
 * Phase 3 — mint the next financial-year-scoped General Ledger id, e.g.
 * GL-2026-000001. Keyed per FY start year so each year restarts at 000001, the
 * id is minted server-side only and, once written onto a general_ledger row, is
 * never rewritten — so every ledger id is unique and immutable. Shared by BOTH
 * the automated source-document posting engine (here) and the manual-journal
 * posting path so every ledger row carries the same GL-YYYY-###### shape.
 *
 * Defined in the low-level posting engine (rather than finance-journal) so the
 * manual-journal module can import it without creating an import cycle.
 */
export async function nextLedgerId(dateStr?: string | null): Promise<string> {
  const today = new Date().toISOString().slice(0, 10)
  const fy = financialYearFor(dateStr) || financialYearFor(today)
  const startYear = fy.split("-")[0] || String(new Date().getFullYear())
  const seq = await nextRecordId(`GL${startYear}`, { digits: 6, allowCustom: true })
  const number = seq.split("-")[1] ?? "000001"
  return `GL-${startYear}-${number}`
}

/**
 * Phase 33/34/36 — self-healing schema for the General Ledger reliability
 * upgrade. Two additive changes, both idempotent and non-destructive:
 *
 *   1. `posting_date` — the accounting date a ledger row was actually posted,
 *      kept alongside (never overwriting) the existing transaction_date /
 *      value_date so the posted-on date is queryable in its own right.
 *   2. A UNIQUE index on `journal_entry_id` so one posted journal line can back
 *      at most one ledger row. This turns the existing application-level
 *      idempotency check into a hard database guarantee — a retry, a concurrent
 *      re-post, or a re-run of the sync can never double-write a ledger row.
 *      The unique index is only added when the data is already clean; if legacy
 *      duplicates exist we fall back to a plain index and log, so this helper
 *      never risks a destructive dedupe (a duplicate is repaired deliberately,
 *      not silently here).
 *
 * Runs at most once per process. Must be called OUTSIDE any open transaction
 * (an ALTER implicitly commits), so callers invoke it before beginTransaction.
 */
let glColumnsEnsured = false
export async function ensureGeneralLedgerColumns(): Promise<void> {
  if (glColumnsEnsured) return

  const [pd] = (await query(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'general_ledger'
         AND column_name = 'posting_date' LIMIT 1`,
  )) as any[]
  if (!pd) {
    await query(
      `ALTER TABLE general_ledger
         ADD COLUMN posting_date DATE DEFAULT NULL AFTER value_date,
         ADD KEY idx_gl_posting_date (posting_date)`,
    )
  }

  const [hasUnique] = (await query(
    `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'general_ledger'
         AND index_name = 'uq_gl_journal_entry_id' LIMIT 1`,
  )) as any[]
  if (!hasUnique) {
    const [hasPlain] = (await query(
      `SELECT 1 FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = 'general_ledger'
           AND index_name = 'idx_gl_journal_entry_id' LIMIT 1`,
    )) as any[]
    const dups = (await query(
      `SELECT journal_entry_id FROM general_ledger
        WHERE journal_entry_id IS NOT NULL AND journal_entry_id <> ''
        GROUP BY journal_entry_id HAVING COUNT(*) > 1 LIMIT 1`,
    )) as any[]
    if (dups.length === 0) {
      try {
        await query(`ALTER TABLE general_ledger ADD UNIQUE KEY uq_gl_journal_entry_id (journal_entry_id)`)
        if (hasPlain) {
          await query(`ALTER TABLE general_ledger DROP KEY idx_gl_journal_entry_id`).catch(() => {})
        }
      } catch (error) {
        console.log("[v0] general_ledger unique journal_entry_id index skipped:", (error as Error).message)
      }
    } else {
      if (!hasPlain) {
        await query(`ALTER TABLE general_ledger ADD KEY idx_gl_journal_entry_id (journal_entry_id)`).catch(() => {})
      }
      console.log(
        "[v0] general_ledger has duplicate journal_entry_id rows — run the ledger sync to repair before the unique guard can be enforced.",
      )
    }
  }

  glColumnsEnsured = true
}

export type PostingLine = {
  role: AccountRole
  debit: number
  credit: number
  /** portion of this line that is tax, for GST/TDS reporting on the row */
  gst?: number
  tds?: number
  /**
   * Optional explicit Chart-of-Accounts id. When present the line posts to this
   * exact account instead of the role's default (Phase 11 — an expense posts to
   * its own mapped expense head). The role is still carried for reporting/debit-
   * nature fallback if the account cannot be resolved.
   */
  accountId?: string | null
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

/**
 * Build the balanced posting lines for a purchase bill from its stored totals
 * (Phase 33/34). The double entry recognises the input-tax credit as an asset
 * and splits the credit side between the vendor payable and the TDS we withhold:
 *
 *   Dr Purchases / Expense    taxable_amount
 *   Dr Input CGST/SGST/IGST   respective tax amounts   (only when > 0)
 *   Dr Input Cess             other_tax_cess
 *      Cr TDS Payable         tds_amount                (only when TDS applies)
 *      Cr Accounts Payable    net_payable               (gross − TDS)
 *
 * Debit total (gross) always equals the credit total (tds + net_payable = gross),
 * so the posting balances by construction.
 */
export function buildPurchaseBillLines(bill: Record<string, any>): PostingLine[] {
  const taxable = round2(num(bill.taxable_amount))
  const cgst = round2(num(bill.cgst_amount))
  const sgst = round2(num(bill.sgst_amount))
  const igst = round2(num(bill.igst_amount))
  const cess = round2(num(bill.other_tax_cess))
  const tds = round2(num(bill.tds_amount))
  const gross = round2(num(bill.gross_bill_amount) || taxable + cgst + sgst + igst + cess)
  const payable = round2(gross - tds)

  const lines: PostingLine[] = []
  if (taxable !== 0) lines.push({ role: "purchase", debit: taxable, credit: 0 })
  if (cgst > 0) lines.push({ role: "input_cgst", debit: cgst, credit: 0, gst: cgst })
  if (sgst > 0) lines.push({ role: "input_sgst", debit: sgst, credit: 0, gst: sgst })
  if (igst > 0) lines.push({ role: "input_igst", debit: igst, credit: 0, gst: igst })
  if (cess > 0) lines.push({ role: "input_cess", debit: cess, credit: 0, gst: cess })
  if (tds > 0) lines.push({ role: "tds_payable", debit: 0, credit: tds, tds })
  if (payable !== 0) lines.push({ role: "payable", debit: 0, credit: payable })
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
  // before we open a transaction. A line keyed to an explicit account id posts
  // to that exact head; everything else resolves via its role default. Explicit
  // ids are cached separately so a role and a same-role explicit head coexist.
  const resolved = new Map<AccountRole, ResolvedAccount>()
  const resolvedById = new Map<string, ResolvedAccount>()
  for (const line of oriented) {
    if (line.accountId) {
      if (!resolvedById.has(line.accountId)) {
        const explicit = (await resolveAccountById(line.accountId)) ?? (await resolveAccount(line.role))
        resolvedById.set(line.accountId, explicit)
      }
    } else if (!resolved.has(line.role)) {
      resolved.set(line.role, await resolveAccount(line.role))
    }
  }

  // Requirement 13: an Inactive/Archived account may never receive a *new*
  // posting. Reversals are exempt so a document posted while its head was Active
  // can still be unwound after the head is later deactivated (keeps history
  // consistent — requirement 20). Only explicit heads are user-selectable and
  // can be non-active; role control heads are system accounts and stay Active.
  if (!args.reverse) {
    for (const account of resolvedById.values()) {
      const status = String(account.active_status ?? "Active")
      if (status !== "Active") {
        throw new Error(
          `Account ${account.account_name} (${account.account_code ?? account.account_id}) is ${status} and cannot receive new postings. Reactivate it or choose an active account.`,
        )
      }
    }
  }

  // Phase 36 — make sure the ledger carries the posting_date column (and the
  // duplicate guard) before we open the transaction; an ALTER cannot run inside
  // one.
  await ensureGeneralLedgerColumns()

  const voucherNo = await nextRecordId("VCH")
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const journalEntryIds: string[] = []
    const ledgerIds: string[] = []

    for (const line of oriented) {
      const account = line.accountId ? resolvedById.get(line.accountId)! : resolved.get(line.role)!
      const journalEntryId = await nextRecordId("JE")
      const ledgerId = await nextLedgerId(args.date)

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
           (ledger_id, journal_entry_id, voucher_no, financial_year, transaction_date, value_date, posting_date,
            account_id, account_name, account_group, account_type, transaction_type, voucher_type,
            reference_no, party_id, party_name, project_id, project_name, description, debit, credit,
            amount, gst_amount, tds_amount, balance, balance_type, source_module, source_reference,
            source_entity_type, source_entity_id, reconciliation_status, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          ledgerId, journalEntryId, voucherNo, args.financialYear, args.date, args.date, args.date,
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

/** Post a purchase bill from its stored (server-authoritative) totals. */
export async function postPurchaseBill(
  bill: Record<string, any>,
  opts: { createdBy?: number | null; reverse?: boolean } = {},
): Promise<PostingResult> {
  await ensurePurchasePostingAccounts()
  const lines = buildPurchaseBillLines(bill)
  return postLines(lines, {
    entityType: "purchase_bill",
    entityId: Number(bill.id),
    entityRef: String(bill.bill_id || bill.id),
    date: String(bill.bill_date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    financialYear: bill.financial_year ?? null,
    partyId: bill.vendor_id || null,
    partyName: bill.vendor_name || bill.vendor_legal_name || null,
    projectId: bill.project_id || null,
    projectName: bill.project_name || null,
    voucherType: "Purchase",
    narration: opts.reverse
      ? `Reversal of purchase bill ${bill.bill_id || bill.id}`
      : `Purchase bill ${bill.bill_id || bill.id}${bill.vendor_name ? ` — ${bill.vendor_name}` : ""}`,
    sourceModule: "Purchase Bill",
    createdBy: opts.createdBy ?? null,
    reverse: opts.reverse,
  })
}

/** Bill statuses that must NOT hold an active accounting posting. */
const UNPOSTABLE_STATUSES = new Set(["Cancelled", "Draft", "Void"])

/**
 * Idempotently keep a purchase bill's Journal + General Ledger posting in sync
 * with its stored totals (Phases 35–37, 123, 144, 148). Keyed off the bill's
 * `voucher_no` + a stored `posted_gross`:
 *   - nothing to post (zero gross, or an unpostable status) → reverse any
 *     existing voucher and clear the posting columns;
 *   - already posted with the same gross → no-op (never double-posts);
 *   - posted with a changed gross → reverse the old voucher, post a fresh one;
 *   - not yet posted → post and stamp the voucher onto the bill.
 *
 * Failures are swallowed and surfaced as an "Unposted" state so a transient
 * posting error (e.g. a missing ledger account) never blocks bill CRUD; the
 * next save re-attempts the posting.
 */
export async function syncPurchaseBillPosting(
  billId: string,
  opts: { createdBy?: number | null } = {},
): Promise<{ action: "posted" | "reposted" | "reversed" | "skipped" | "error"; voucherNo?: string }> {
  const [bill] = (await query(`SELECT * FROM purchase_bills WHERE bill_id = ? LIMIT 1`, [billId])) as any[]
  if (!bill) return { action: "skipped" }

  const gross = round2(
    num(bill.gross_bill_amount) ||
      num(bill.taxable_amount) + num(bill.cgst_amount) + num(bill.sgst_amount) + num(bill.igst_amount) + num(bill.other_tax_cess),
  )
  const status = String(bill.payment_status || "").trim()
  const existingVoucher = bill.voucher_no ? String(bill.voucher_no) : null
  const postedGross = round2(num(bill.posted_gross))

  // Snapshot of the money fields exactly as they were posted; a reversal must
  // unwind these, never the (possibly edited) current amounts.
  let postedSnapshot: Record<string, any> = bill
  if (bill.posted_snapshot) {
    try {
      postedSnapshot = { ...JSON.parse(String(bill.posted_snapshot)), id: bill.id, bill_id: bill.bill_id }
    } catch {
      postedSnapshot = bill
    }
  }

  const snapshotOf = (b: Record<string, any>) => ({
    id: b.id,
    bill_id: b.bill_id,
    bill_date: b.bill_date,
    financial_year: b.financial_year,
    vendor_id: b.vendor_id,
    vendor_name: b.vendor_name,
    vendor_legal_name: b.vendor_legal_name,
    project_id: b.project_id,
    project_name: b.project_name,
    taxable_amount: num(b.taxable_amount),
    cgst_amount: num(b.cgst_amount),
    sgst_amount: num(b.sgst_amount),
    igst_amount: num(b.igst_amount),
    other_tax_cess: num(b.other_tax_cess),
    tds_amount: num(b.tds_amount),
    gross_bill_amount: num(b.gross_bill_amount),
  })

  const reverseExisting = async () => {
    if (!existingVoucher) return
    await postPurchaseBill(postedSnapshot, { createdBy: opts.createdBy ?? null, reverse: true })
    await query(
      `UPDATE purchase_bills
          SET reversal_voucher_no = ?, voucher_no = NULL, posting_status = 'Unposted', posted_gross = 0, posted_snapshot = NULL
        WHERE id = ?`,
      [existingVoucher, bill.id],
    )
  }

  try {
    // Nothing postable → unwind any prior posting.
    if (gross <= 0 || UNPOSTABLE_STATUSES.has(status)) {
      if (existingVoucher) {
        await reverseExisting()
        return { action: "reversed" }
      }
      return { action: "skipped" }
    }

    // Already posted and unchanged → idempotent no-op.
    if (existingVoucher && Math.abs(postedGross - gross) <= 0.01) {
      return { action: "skipped", voucherNo: existingVoucher }
    }

    // Amount changed on a posted bill → reverse then re-post.
    let reposted = false
    if (existingVoucher) {
      await reverseExisting()
      reposted = true
    }

    const result = await postPurchaseBill(bill, { createdBy: opts.createdBy ?? null })
    await query(
      `UPDATE purchase_bills
          SET voucher_no = ?, posting_status = 'Posted', posted_at = NOW(), posted_gross = ?, posted_snapshot = ?
        WHERE id = ?`,
      [result.voucherNo, gross, JSON.stringify(snapshotOf(bill)), bill.id],
    )
    return { action: reposted ? "reposted" : "posted", voucherNo: result.voucherNo }
  } catch (error) {
    console.log("[v0] purchase bill posting failed for", billId, (error as Error)?.message)
    await query(`UPDATE purchase_bills SET posting_status = 'Unposted' WHERE id = ?`, [bill.id]).catch(() => {})
    return { action: "error" }
  }
}

/** Reverse and clear a purchase bill's posting (used when the bill is deleted). */
export async function reversePurchaseBillPosting(bill: Record<string, any>): Promise<void> {
  if (!bill?.voucher_no) return
  let toReverse: Record<string, any> = bill
  if (bill.posted_snapshot) {
    try {
      toReverse = { ...JSON.parse(String(bill.posted_snapshot)), id: bill.id, bill_id: bill.bill_id }
    } catch {
      toReverse = bill
    }
  }
  try {
    await postPurchaseBill(toReverse, { reverse: true })
  } catch (error) {
    console.log("[v0] purchase bill reversal failed for", bill?.bill_id, (error as Error)?.message)
  }
}
