import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { financialYearFor } from "@/lib/finance-calc"
import { resolveAccountById, isDebitNature, type ResolvedAccount } from "@/lib/finance-accounts"
import { logFinanceEvent } from "@/lib/finance-audit"

// ---------------------------------------------------------------------------
// Manual journal engine (server-only) — the central accounting workflow.
//
// A manual journal is a user-authored, balanced double-entry voucher. Unlike
// the automated source postings (sales, purchase, expense, bank, GST, TDS) it
// is entered by hand as a set of debit/credit lines against real
// Chart-of-Accounts heads.
//
// One financial-year-scoped, immutable group id (JE-2026-000001) ties every
// line of a single journal together. It is stored in `voucher_no` (the shared
// grouping column already used by the posting engine); each line additionally
// carries a unique `journal_entry_id` of the form JE-2026-000001-1 so the
// table's per-row uniqueness constraint and the ledger join both hold.
//
// LIFECYCLE (manual journals only — automated postings are untouched):
//
//   Draft ─submit→ Pending Approval ─approve→ Approved ─post→ Posted ─reverse→ Reversed
//     │                    │                                                  
//     └────────cancel──────┴─reject→ Rejected ──(edit back to Draft)          
//
// GL posting is DEFERRED until the journal reaches "Posted": a Draft / Pending
// Approval / Approved / Rejected / Cancelled journal lives only in
// journal_entries (no general_ledger rows), so it never affects the ledger or
// any report that re-sums it. Posting writes the balanced general_ledger lines
// with a running balance inside one transaction; reversing posts the contra
// lines under the same voucher (netting to zero) so the ledger stays balanced
// and its running-balance chain always moves forward.
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export const MANUAL_JOURNAL_SOURCE = "Manual"

/**
 * Voucher types a manual journal line may carry (Phase 17). The original four
 * (Journal / Payment / Receipt / Contra) are preserved; the rest let the manual
 * engine stand in for every accounting document class an operator may post by
 * hand without leaving the Journal Entries screen.
 */
export const MANUAL_JOURNAL_VOUCHER_TYPES = [
  "Journal",
  "Payment",
  "Receipt",
  "Contra",
  "Sales",
  "Purchase",
  "Expense",
  "Credit Note",
  "Debit Note",
  "GST",
  "TDS",
  "Adjustment",
  "Opening",
  "Closing",
] as const

/** The single-dimension workflow status a manual journal moves through. */
export const JOURNAL_STATUSES = [
  "Draft",
  "Pending Approval",
  "Approved",
  "Rejected",
  "Cancelled",
  "Posted",
  "Reversed",
] as const
export type JournalStatus = (typeof JOURNAL_STATUSES)[number]

/** Workflow actions callable against a manual journal group. */
export const JOURNAL_ACTIONS = ["submit", "approve", "reject", "cancel", "post", "reverse"] as const
export type JournalAction = (typeof JOURNAL_ACTIONS)[number]

// Allowed source states for each action. The engine enforces this so an
// out-of-order request (e.g. posting a Draft) is rejected before any write.
const ACTION_FROM: Record<JournalAction, JournalStatus[]> = {
  submit: ["Draft", "Rejected"],
  approve: ["Pending Approval"],
  reject: ["Pending Approval"],
  cancel: ["Draft", "Pending Approval", "Approved", "Rejected"],
  post: ["Approved"],
  reverse: ["Posted"],
}

export type ManualJournalLineInput = {
  accountId: string
  debit: number
  credit: number
  partyId?: string | null
  partyName?: string | null
  projectId?: string | null
  projectName?: string | null
  narration?: string | null
  gst?: number
  tds?: number
}

export type ManualJournalInput = {
  journalDate: string
  financialYear?: string | null
  voucherType?: string
  referenceNo?: string | null
  narration?: string | null
  lines: ManualJournalLineInput[]
}

export type ManualJournalResult = {
  journalId: string
  financialYear: string
  status: JournalStatus
  lineIds: string[]
  totalDebit: number
  totalCredit: number
}

/**
 * Mint the next financial-year-scoped, concurrency-safe manual journal id,
 * e.g. JE-2026-000001. The sequence is keyed per FY start year so each year
 * restarts at 000001, and the id is never client-supplied so it is immutable.
 */
export async function nextManualJournalId(
  dateStr?: string | null,
): Promise<{ journalId: string; financialYear: string }> {
  const today = new Date().toISOString().slice(0, 10)
  const fy = financialYearFor(dateStr) || financialYearFor(today)
  const startYear = fy.split("-")[0] || String(new Date().getFullYear())
  const seq = await nextRecordId(`JE${startYear}`, { digits: 6, allowCustom: true })
  const number = seq.split("-")[1] ?? "000001"
  return { journalId: `JE-${startYear}-${number}`, financialYear: fy }
}

/**
 * Validate the shape of a manual journal before any account resolution or
 * write. Returns a human error string, or null when the journal is well formed
 * and balanced. A journal needs at least two lines, each line carries exactly
 * one side (debit XOR credit, both non-negative), and total debit must equal
 * total credit and be greater than zero.
 */
export function validateManualJournal(input: ManualJournalInput): string | null {
  if (!input.journalDate) return "A journal date is required."
  const lines = Array.isArray(input.lines) ? input.lines : []
  if (lines.length < 2) return "A journal needs at least two lines (one debit and one credit)."

  let totalDebit = 0
  let totalCredit = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const label = `Line ${i + 1}`
    if (!line.accountId) return `${label}: choose an account.`
    const debit = num(line.debit)
    const credit = num(line.credit)
    if (debit < 0 || credit < 0) return `${label}: amounts cannot be negative.`
    if (debit > 0 && credit > 0) return `${label}: enter either a debit or a credit, not both.`
    if (debit === 0 && credit === 0) return `${label}: enter a debit or a credit amount.`
    totalDebit += round2(debit)
    totalCredit += round2(credit)
  }
  totalDebit = round2(totalDebit)
  totalCredit = round2(totalCredit)
  if (totalDebit <= 0) return "The journal total must be greater than zero."
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return `The journal is not balanced: debit ${totalDebit.toFixed(2)} ≠ credit ${totalCredit.toFixed(2)}.`
  }
  return null
}

/** Read the current signed running balance for an account within the txn. */
async function currentSignedBalance(conn: PoolConnection, account: ResolvedAccount): Promise<number> {
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

/** Resolve + snapshot every line's Chart-of-Accounts head, rejecting inactive
 *  or missing accounts before any write. Shared by create and post. */
async function resolveLines(
  lines: ManualJournalLineInput[],
  opts: { requireActive?: boolean } = {},
): Promise<ResolvedAccount[]> {
  const resolved: ResolvedAccount[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const account = await resolveAccountById(line.accountId)
    if (!account) throw new Error(`Line ${i + 1}: account ${line.accountId} was not found in the Chart of Accounts.`)
    if (opts.requireActive !== false) {
      const status = String(account.active_status ?? "Active")
      if (status !== "Active") {
        throw new Error(
          `Line ${i + 1}: account ${account.account_name} (${account.account_code ?? account.account_id}) is ${status} and cannot receive new postings.`,
        )
      }
    }
    resolved.push(account)
  }
  return resolved
}

/**
 * Create a manual journal as an UNPOSTED workflow document (Phase 18/19). The
 * balanced lines are written to journal_entries only — no general_ledger rows
 * are created, so the journal has zero effect on the ledger or any report until
 * it is later Posted. It starts as "Draft", or "Pending Approval" when the
 * author submits it for approval in the same action.
 */
export async function createManualJournal(
  input: ManualJournalInput,
  opts: { createdBy?: number | null; submit?: boolean; actorName?: string | null } = {},
): Promise<ManualJournalResult> {
  const shapeError = validateManualJournal(input)
  if (shapeError) throw new Error(shapeError)

  const voucherType =
    input.voucherType && String(input.voucherType).trim() ? String(input.voucherType).trim() : "Journal"
  const resolved = await resolveLines(input.lines)

  const { journalId, financialYear } = await nextManualJournalId(input.journalDate)
  const fy = input.financialYear && String(input.financialYear).trim() ? String(input.financialYear).trim() : financialYear
  const narration = input.narration ? String(input.narration) : null
  const referenceNo = input.referenceNo ? String(input.referenceNo) : null
  const status: JournalStatus = opts.submit ? "Pending Approval" : "Draft"

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const lineIds: string[] = []
    let totalDebit = 0
    let totalCredit = 0

    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i]
      const account = resolved[i]
      const debit = round2(num(line.debit))
      const credit = round2(num(line.credit))
      totalDebit += debit
      totalCredit += credit

      const lineId = `${journalId}-${i + 1}`
      const lineNarration = line.narration ? String(line.narration) : narration

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
          lineId, journalId, input.journalDate, fy, "Manual",
          referenceNo, voucherType, lineNarration, account.account_id, account.account_name,
          account.account_group, account.account_type, line.partyId ?? null, line.partyName ?? null,
          line.projectId ?? null, line.projectName ?? null, debit, credit,
          round2(debit - credit), round2(num(line.gst)), round2(num(line.tds)),
          MANUAL_JOURNAL_SOURCE, journalId, "manual_journal", null, status, null,
          "Unposted", null, opts.createdBy ?? null,
        ],
      )
      lineIds.push(lineId)
    }

    await conn.commit()
    await logFinanceEvent({
      entityType: "journal",
      entityRef: journalId,
      type: opts.submit ? "submitted" : "created",
      summary: opts.submit ? `Journal ${journalId} submitted for approval` : `Journal ${journalId} drafted`,
      amount: round2(totalDebit),
      voucherNo: journalId,
      actorId: opts.createdBy ?? null,
      actorName: opts.actorName ?? null,
    })
    return {
      journalId,
      financialYear: fy,
      status,
      lineIds,
      totalDebit: round2(totalDebit),
      totalCredit: round2(totalCredit),
    }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

/** Header + lines for a single manual journal group (for detail / edit). */
export async function getManualJournal(journalId: string): Promise<{ status: JournalStatus | null; rows: any[] }> {
  const rows = (await query(
    `SELECT * FROM journal_entries WHERE voucher_no = ? AND source_module = ? ORDER BY id ASC`,
    [journalId, MANUAL_JOURNAL_SOURCE],
  )) as any[]
  const status = (rows[0]?.approval_status as JournalStatus) ?? null
  return { status, rows }
}

/**
 * Replace the lines of an editable (unposted) manual journal. Only a Draft,
 * Pending Approval or Rejected journal may be edited; editing always returns it
 * to Draft so it re-enters the approval flow. The immutable group id is kept.
 */
export async function updateManualJournalDraft(
  journalId: string,
  input: ManualJournalInput,
  opts: { userId?: number | null; actorName?: string | null } = {},
): Promise<ManualJournalResult> {
  const { status, rows } = await getManualJournal(journalId)
  if (!rows.length) throw new Error("This journal was not found.")
  if (!status || !["Draft", "Pending Approval", "Rejected"].includes(status)) {
    throw new Error(`A ${status ?? "posted"} journal cannot be edited. Only a Draft, Pending Approval or Rejected journal is editable.`)
  }
  const shapeError = validateManualJournal(input)
  if (shapeError) throw new Error(shapeError)

  const voucherType =
    input.voucherType && String(input.voucherType).trim() ? String(input.voucherType).trim() : "Journal"
  const resolved = await resolveLines(input.lines)
  const createdBy = rows[0]?.created_by ?? opts.userId ?? null
  const fy =
    input.financialYear && String(input.financialYear).trim()
      ? String(input.financialYear).trim()
      : financialYearFor(input.journalDate) || String(rows[0]?.financial_year ?? "")
  const narration = input.narration ? String(input.narration) : null
  const referenceNo = input.referenceNo ? String(input.referenceNo) : null

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // An unposted journal has no general_ledger rows; replacing its journal
    // lines is safe and leaves the ledger untouched.
    await conn.query(`DELETE FROM journal_entries WHERE voucher_no = ? AND source_module = ?`, [
      journalId,
      MANUAL_JOURNAL_SOURCE,
    ])

    const lineIds: string[] = []
    let totalDebit = 0
    let totalCredit = 0
    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i]
      const account = resolved[i]
      const debit = round2(num(line.debit))
      const credit = round2(num(line.credit))
      totalDebit += debit
      totalCredit += credit
      const lineId = `${journalId}-${i + 1}`
      const lineNarration = line.narration ? String(line.narration) : narration
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
          lineId, journalId, input.journalDate, fy, "Manual",
          referenceNo, voucherType, lineNarration, account.account_id, account.account_name,
          account.account_group, account.account_type, line.partyId ?? null, line.partyName ?? null,
          line.projectId ?? null, line.projectName ?? null, debit, credit,
          round2(debit - credit), round2(num(line.gst)), round2(num(line.tds)),
          MANUAL_JOURNAL_SOURCE, journalId, "manual_journal", null, "Draft", null,
          "Unposted", null, createdBy,
        ],
      )
      lineIds.push(lineId)
    }
    await conn.commit()
    await logFinanceEvent({
      entityType: "journal",
      entityRef: journalId,
      type: "updated",
      summary: `Journal ${journalId} edited (returned to Draft)`,
      amount: round2(totalDebit),
      voucherNo: journalId,
      actorId: opts.userId ?? null,
      actorName: opts.actorName ?? null,
    })
    return {
      journalId,
      financialYear: fy,
      status: "Draft",
      lineIds,
      totalDebit: round2(totalDebit),
      totalCredit: round2(totalCredit),
    }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

/**
 * Write the balanced general_ledger lines for a set of journal_entries rows,
 * appending a running balance in each account's natural direction. When
 * `reverse` is set the debit/credit of every line is swapped (used to unwind a
 * posted voucher). Runs inside the caller's transaction.
 */
async function writeLedgerFromRows(
  conn: PoolConnection,
  rows: any[],
  resolved: ResolvedAccount[],
  opts: { reverse?: boolean; createdBy?: number | null } = {},
): Promise<string[]> {
  const ledgerIds: string[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const account = resolved[i]
    const debit = round2(opts.reverse ? num(row.credit) : num(row.debit))
    const credit = round2(opts.reverse ? num(row.debit) : num(row.credit))
    const ledgerId = await nextRecordId("GL")

    const prev = await currentSignedBalance(conn, account)
    const naturalDebit = isDebitNature(account)
    const signedDelta = naturalDebit ? debit - credit : credit - debit
    const running = round2(prev + signedDelta)
    const balanceType = running >= 0 ? (naturalDebit ? "Debit" : "Credit") : naturalDebit ? "Credit" : "Debit"
    const description = opts.reverse
      ? `Reversal of ${row.voucher_no}${row.narration ? ` — ${row.narration}` : ""}`
      : row.narration

    await conn.query(
      `INSERT INTO general_ledger
         (ledger_id, journal_entry_id, voucher_no, financial_year, transaction_date, value_date,
          account_id, account_name, account_group, account_type, transaction_type, voucher_type,
          reference_no, party_id, party_name, project_id, project_name, description, debit, credit,
          amount, gst_amount, tds_amount, balance, balance_type, source_module, source_reference,
          source_entity_type, source_entity_id, reconciliation_status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ledgerId, row.journal_entry_id, row.voucher_no, row.financial_year, row.journal_date, row.journal_date,
        account.account_id, account.account_name, account.account_group, account.account_type,
        debit > 0 ? "Debit" : "Credit", row.voucher_type, row.reference_no,
        row.party_id ?? null, row.party_name ?? null, row.project_id ?? null, row.project_name ?? null,
        description, debit, credit, round2(credit > 0 ? credit : debit),
        round2(num(row.gst_amount)), round2(num(row.tds_amount)), Math.abs(running), balanceType,
        MANUAL_JOURNAL_SOURCE, row.voucher_no, "manual_journal", null, "Unreconciled",
        opts.createdBy ?? null,
      ],
    )
    ledgerIds.push(ledgerId)
  }
  return ledgerIds
}

/**
 * Post an APPROVED manual journal to the general ledger (Phase 19). Writes the
 * balanced ledger lines with running balances inside one transaction and stamps
 * the journal_entries rows Posted. Re-validated and re-resolved at post time so
 * a since-deactivated account or a since-broken balance is caught here.
 */
async function postManualJournalGroup(
  journalId: string,
  opts: { userId?: number | null; actorName?: string | null } = {},
): Promise<void> {
  const { status, rows } = await getManualJournal(journalId)
  if (!rows.length) throw new Error("This journal was not found.")
  if (status !== "Approved") throw new Error(`Only an Approved journal can be posted (this one is ${status}).`)

  const lines: ManualJournalLineInput[] = rows.map((r) => ({
    accountId: String(r.account_id),
    debit: num(r.debit),
    credit: num(r.credit),
  }))
  const shapeError = validateManualJournal({ journalDate: String(rows[0].journal_date), lines })
  if (shapeError) throw new Error(shapeError)
  const resolved = await resolveLines(lines)
  const today = new Date().toISOString().slice(0, 10)
  const postingDate = String(rows[0].journal_date || today).slice(0, 10)

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await writeLedgerFromRows(conn, rows, resolved, { createdBy: opts.userId ?? null })
    await conn.query(
      `UPDATE journal_entries
          SET approval_status = 'Posted', posting_status = 'Posted', posting_date = ?
        WHERE voucher_no = ? AND source_module = ?`,
      [postingDate, journalId, MANUAL_JOURNAL_SOURCE],
    )
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
  await logFinanceEvent({
    entityType: "journal",
    entityRef: journalId,
    type: "posted",
    summary: `Journal ${journalId} posted to the general ledger`,
    amount: round2(rows.reduce((s, r) => s + num(r.debit), 0)),
    voucherNo: journalId,
    actorId: opts.userId ?? null,
    actorName: opts.actorName ?? null,
  })
}

/**
 * Reverse a POSTED manual journal (Phase 19). Posts the contra general_ledger
 * lines under the same voucher (so the voucher nets to zero in every ledger
 * aggregate while its full history is preserved) and stamps the journal
 * Reversed. Running balances move forward, never rewriting history.
 */
async function reverseManualJournalGroup(
  journalId: string,
  opts: { userId?: number | null; actorName?: string | null } = {},
): Promise<void> {
  const { status, rows } = await getManualJournal(journalId)
  if (!rows.length) throw new Error("This journal was not found.")
  if (status !== "Posted") throw new Error(`Only a Posted journal can be reversed (this one is ${status}).`)

  const lines: ManualJournalLineInput[] = rows.map((r) => ({
    accountId: String(r.account_id),
    debit: num(r.debit),
    credit: num(r.credit),
  }))
  const resolved = await resolveLines(lines, { requireActive: false })

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await writeLedgerFromRows(conn, rows, resolved, { reverse: true, createdBy: opts.userId ?? null })
    await conn.query(
      `UPDATE journal_entries
          SET approval_status = 'Reversed', posting_status = 'Reversed'
        WHERE voucher_no = ? AND source_module = ?`,
      [journalId, MANUAL_JOURNAL_SOURCE],
    )
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
  await logFinanceEvent({
    entityType: "journal",
    entityRef: journalId,
    type: "reversed",
    summary: `Journal ${journalId} reversed out of the general ledger`,
    amount: round2(rows.reduce((s, r) => s + num(r.debit), 0)),
    voucherNo: journalId,
    actorId: opts.userId ?? null,
    actorName: opts.actorName ?? null,
  })
}

/**
 * Drive a manual journal through its lifecycle. Enforces the allowed source
 * state for every action (so posting a Draft or approving a Posted journal is
 * rejected before any write), delegates the GL side effects for post/reverse,
 * and records who did what on the journal_entries rows + the audit trail.
 */
export async function transitionManualJournal(
  journalId: string,
  action: JournalAction,
  opts: { userId?: number | null; actorName?: string | null; reason?: string | null } = {},
): Promise<{ status: JournalStatus }> {
  const { status } = await getManualJournal(journalId)
  if (!status) throw new Error("This journal was not found, or it is a system posting that must be reversed through its source document.")
  const allowed = ACTION_FROM[action]
  if (!allowed.includes(status)) {
    throw new Error(`Cannot ${action} a ${status} journal.`)
  }

  const actor = opts.actorName ? String(opts.actorName) : null

  switch (action) {
    case "post":
      await postManualJournalGroup(journalId, opts)
      return { status: "Posted" }
    case "reverse":
      await reverseManualJournalGroup(journalId, opts)
      return { status: "Reversed" }
    case "submit": {
      await query(
        `UPDATE journal_entries SET approval_status = 'Pending Approval'
          WHERE voucher_no = ? AND source_module = ?`,
        [journalId, MANUAL_JOURNAL_SOURCE],
      )
      await logFinanceEvent({ entityType: "journal", entityRef: journalId, type: "submitted", summary: `Journal ${journalId} submitted for approval`, voucherNo: journalId, actorId: opts.userId ?? null, actorName: actor })
      return { status: "Pending Approval" }
    }
    case "approve": {
      await query(
        `UPDATE journal_entries SET approval_status = 'Approved', approved_by = ?
          WHERE voucher_no = ? AND source_module = ?`,
        [actor ?? "Approved", journalId, MANUAL_JOURNAL_SOURCE],
      )
      await logFinanceEvent({ entityType: "journal", entityRef: journalId, type: "approved", summary: `Journal ${journalId} approved`, voucherNo: journalId, actorId: opts.userId ?? null, actorName: actor })
      return { status: "Approved" }
    }
    case "reject": {
      await query(
        `UPDATE journal_entries SET approval_status = 'Rejected'
          WHERE voucher_no = ? AND source_module = ?`,
        [journalId, MANUAL_JOURNAL_SOURCE],
      )
      await logFinanceEvent({ entityType: "journal", entityRef: journalId, type: "rejected", summary: `Journal ${journalId} rejected`, detail: opts.reason ? { reason: opts.reason } : null, voucherNo: journalId, actorId: opts.userId ?? null, actorName: actor })
      return { status: "Rejected" }
    }
    case "cancel": {
      await query(
        `UPDATE journal_entries SET approval_status = 'Cancelled'
          WHERE voucher_no = ? AND source_module = ?`,
        [journalId, MANUAL_JOURNAL_SOURCE],
      )
      await logFinanceEvent({ entityType: "journal", entityRef: journalId, type: "cancelled", summary: `Journal ${journalId} cancelled`, detail: opts.reason ? { reason: opts.reason } : null, voucherNo: journalId, actorId: opts.userId ?? null, actorName: actor })
      return { status: "Cancelled" }
    }
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}

/**
 * Delete a manual journal. Only manual vouchers (source_module = 'Manual') are
 * removable here, and only while UNPOSTED — a Posted journal owns balanced
 * ledger rows and must be Reversed instead so the books stay balanced. An
 * automated posting is never deletable here; it is reversed through its own
 * source document. As an unposted journal has no general_ledger rows this only
 * removes its journal_entries lines.
 */
export async function deleteManualJournal(journalId: string): Promise<{ removed: number }> {
  if (!journalId) return { removed: 0 }
  const { status, rows } = await getManualJournal(journalId)
  if (!rows.length) return { removed: 0 }
  if (status === "Posted") {
    throw new Error("A posted journal cannot be deleted — reverse it instead so the ledger stays balanced.")
  }
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // Defensive: unposted journals carry no ledger rows, but a Reversed one may
    // — clear any that share the voucher so nothing is orphaned.
    await conn.query(`DELETE FROM general_ledger WHERE voucher_no = ? AND source_module = ?`, [
      journalId,
      MANUAL_JOURNAL_SOURCE,
    ])
    const [result] = await conn.query<any>(
      `DELETE FROM journal_entries WHERE voucher_no = ? AND source_module = ?`,
      [journalId, MANUAL_JOURNAL_SOURCE],
    )
    await conn.commit()
    return { removed: Number(result?.affectedRows ?? rows.length) }
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

export type PostableAccount = {
  account_id: string
  account_code: string | null
  account_name: string
  account_group: string | null
  account_type: string | null
  nature: string | null
}

/** Active Chart-of-Accounts heads a manual journal line may post to. */
export async function listPostableAccounts(): Promise<PostableAccount[]> {
  // A merged account is set to 'Archived', so the Active filter already excludes
  // it — no need to reference the lazily-added merged_into_account_id column.
  return (await query(
    `SELECT account_id, account_code, account_name, account_group, account_type, nature
       FROM chart_of_accounts
      WHERE active_status = 'Active'
      ORDER BY account_code IS NULL, account_code ASC, account_name ASC`,
  )) as any[]
}
