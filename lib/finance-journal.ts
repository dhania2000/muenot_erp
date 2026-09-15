import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { financialYearFor } from "@/lib/finance-calc"
import { resolveAccountById, isDebitNature, type ResolvedAccount } from "@/lib/finance-accounts"

// ---------------------------------------------------------------------------
// Manual journal engine (server-only).
//
// A manual journal is a user-authored, balanced double-entry voucher. Unlike
// the automated source postings (sales, purchase, expense, bank) it is entered
// by hand as a set of debit/credit lines against real Chart-of-Accounts heads.
//
// One financial-year-scoped, immutable group id (JE-2026-000001) ties every
// line of a single journal together. It is stored in `voucher_no` (the shared
// grouping column already used by the posting engine); each line additionally
// carries a unique `journal_entry_id` of the form JE-2026-000001-1 so the
// table's per-row uniqueness constraint and the ledger join both hold.
//
// A balanced journal posts immediately to journal_entries + general_ledger
// inside one transaction, so the ledger and every aggregate report stay live.
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export const MANUAL_JOURNAL_SOURCE = "Manual"
export const MANUAL_JOURNAL_VOUCHER_TYPES = ["Journal", "Payment", "Receipt", "Contra"] as const

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
  lineIds: string[]
  ledgerIds: string[]
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

/**
 * Post a balanced manual journal to journal_entries + general_ledger inside one
 * transaction. Resolves every line to a live Chart-of-Accounts head first (so a
 * missing or inactive account fails before the transaction opens), snapshots
 * the account's name/group/type/nature onto each row, and appends a running
 * balance in the account's natural direction. All-or-nothing: any failure rolls
 * the whole journal back so a posting can never land half-written.
 */
export async function postManualJournal(
  input: ManualJournalInput,
  opts: { createdBy?: number | null } = {},
): Promise<ManualJournalResult> {
  const shapeError = validateManualJournal(input)
  if (shapeError) throw new Error(shapeError)

  const voucherType = input.voucherType && String(input.voucherType).trim() ? String(input.voucherType).trim() : "Journal"

  // Resolve + snapshot every account up front. A missing account or one that is
  // not Active may never receive a new posting.
  const resolved: ResolvedAccount[] = []
  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i]
    const account = await resolveAccountById(line.accountId)
    if (!account) throw new Error(`Line ${i + 1}: account ${line.accountId} was not found in the Chart of Accounts.`)
    const status = String(account.active_status ?? "Active")
    if (status !== "Active") {
      throw new Error(
        `Line ${i + 1}: account ${account.account_name} (${account.account_code ?? account.account_id}) is ${status} and cannot receive new postings.`,
      )
    }
    resolved.push(account)
  }

  const { journalId, financialYear } = await nextManualJournalId(input.journalDate)
  const fy = input.financialYear && String(input.financialYear).trim() ? String(input.financialYear).trim() : financialYear
  const narration = input.narration ? String(input.narration) : null
  const referenceNo = input.referenceNo ? String(input.referenceNo) : null

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const lineIds: string[] = []
    const ledgerIds: string[] = []
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
      const ledgerId = await nextRecordId("GL")
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
          MANUAL_JOURNAL_SOURCE, journalId, "manual_journal", null, "Approved", "Manual",
          "Posted", input.journalDate, opts.createdBy ?? null,
        ],
      )
      lineIds.push(lineId)

      const prev = await currentSignedBalance(conn, account)
      const naturalDebit = isDebitNature(account)
      const signedDelta = naturalDebit ? debit - credit : credit - debit
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
          ledgerId, lineId, journalId, fy, input.journalDate, input.journalDate,
          account.account_id, account.account_name, account.account_group, account.account_type,
          debit > 0 ? "Debit" : "Credit", voucherType, referenceNo,
          line.partyId ?? null, line.partyName ?? null, line.projectId ?? null, line.projectName ?? null,
          lineNarration, debit, credit, round2(credit > 0 ? credit : debit),
          round2(num(line.gst)), round2(num(line.tds)), Math.abs(running), balanceType,
          MANUAL_JOURNAL_SOURCE, journalId, "manual_journal", null, "Unreconciled",
          opts.createdBy ?? null,
        ],
      )
      ledgerIds.push(ledgerId)
    }

    await conn.commit()
    return {
      journalId,
      financialYear: fy,
      lineIds,
      ledgerIds,
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
 * Delete a manual journal and unwind it from the ledger. Only manual vouchers
 * (source_module = 'Manual') are removable here; an automated posting must be
 * reversed through its own source document, never deleted directly. Removing
 * the group's journal_entries + general_ledger rows takes the journal straight
 * out of every aggregate report (trial balance, P&L, balance sheet all re-sum
 * the ledger), keeping the books balanced.
 */
export async function deleteManualJournal(journalId: string): Promise<{ removed: number }> {
  if (!journalId) return { removed: 0 }
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<any[]>(
      `SELECT COUNT(*) n FROM journal_entries
        WHERE voucher_no = ? AND source_module = ?`,
      [journalId, MANUAL_JOURNAL_SOURCE],
    )
    const removed = Number(rows?.[0]?.n ?? 0)
    await conn.query(
      `DELETE FROM general_ledger WHERE voucher_no = ? AND source_module = ?`,
      [journalId, MANUAL_JOURNAL_SOURCE],
    )
    await conn.query(
      `DELETE FROM journal_entries WHERE voucher_no = ? AND source_module = ?`,
      [journalId, MANUAL_JOURNAL_SOURCE],
    )
    await conn.commit()
    return { removed }
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
