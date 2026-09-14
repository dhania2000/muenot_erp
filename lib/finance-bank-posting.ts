import "server-only"
import { pool, query } from "@/lib/db"
import { getSettings } from "@/lib/settings/server"
import { postLines, type PostingResult } from "@/lib/finance-posting"
import { resolveAccountById, type AccountRole } from "@/lib/finance-accounts"

const FY_START_MONTH: Record<string, number> = { January: 0, April: 3, July: 6, October: 9 }

/** Financial-year start calendar year for a date, honouring company settings. */
function fyStartYear(dateStr: string | null | undefined, startMonth: number): number {
  const d = dateStr ? new Date(dateStr) : new Date()
  const valid = !Number.isNaN(d.getTime()) ? d : new Date()
  const y = valid.getFullYear()
  return valid.getMonth() >= startMonth ? y : y - 1
}

/**
 * Generate the next Bank Transaction ID: `BT-2026-000001` (Phase 1/26/132).
 *
 * Scoped to the financial year and drawn from the shared `record_id_sequences`
 * table inside a `FOR UPDATE` transaction, so it is unique and concurrency-safe
 * (never MAX+1). The id is immutable — the CRUD factory never rewrites it.
 */
export async function nextBankTransactionId(transactionDate?: string | null): Promise<string> {
  const settings = await getSettings().catch(() => ({}) as Record<string, string>)
  const startMonth = FY_START_MONTH[settings["app.financial_year_start"] as string] ?? 3
  const year = fyStartYear(transactionDate, startMonth)
  const seqKey = `BT${year}`

  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.query(
      "INSERT INTO record_id_sequences (prefix, next_number) VALUES (?, 1) ON DUPLICATE KEY UPDATE next_number = next_number + 1",
      [seqKey],
    )
    const [rows] = await connection.query<any[]>(
      "SELECT next_number FROM record_id_sequences WHERE prefix = ? FOR UPDATE",
      [seqKey],
    )
    const number = Number(rows[0]?.next_number || 1)
    await connection.commit()
    return `BT-${year}-${String(number).padStart(6, "0")}`
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

// ---------------------------------------------------------------------------
// Bank Transaction accounting bridge (Foundation phase).
//
// A Bank Transaction is the real-world counterpart of a movement on a Bank /
// Cash account. Posting it turns the single-account movement into a balanced
// double entry through the SAME engine Purchase Bills / Sales Invoices use
// (postLines → journal_entries + general_ledger) — never a parallel engine.
//
// Statement convention on the row:
//   credit  = deposit  / money INTO the bank account   → bank asset increases
//   debit   = withdrawal / money OUT of the bank account → bank asset decreases
//
// Accounting orientation of the posting:
//   deposit  (credit>0)  →  Dr Bank/Cash   Cr Account head
//   withdrawal (debit>0) →  Dr Account head Cr Bank/Cash
//   transfer             →  Dr receiving bank  Cr sending bank (both bank/cash)
//
// The Bank / Cash side resolves to the seeded "bank" (1000) or "cash" (1010)
// Chart-of-Accounts role; the contra side posts to the explicit account head
// picked from the Chart of Accounts. A transaction with no resolvable contra
// (e.g. a freshly imported row without an account head) is left Unposted rather
// than erroring, so it can be classified and posted later.
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Reconciliation statuses that must NOT hold an active accounting posting. */
const UNPOSTABLE_STATUSES = new Set(["Reversed", "Void", "Cancelled", "Draft"])

/** Cash-like account types post to the "cash" role; everything else to "bank". */
function bankRoleForType(accountType?: string | null): AccountRole {
  return String(accountType ?? "").trim().toLowerCase() === "cash" ? "cash" : "bank"
}

/** Resolve the finance (Bank/Cash) account's type so we pick the right role. */
async function financeAccountType(financeAccountId?: string | null): Promise<string | null> {
  if (!financeAccountId) return null
  const rows = (await query(
    `SELECT account_type FROM finance_accounts WHERE finance_account_id = ? LIMIT 1`,
    [financeAccountId],
  )) as any[]
  return rows?.[0]?.account_type ?? null
}

type BankPostContext = {
  bankRole: AccountRole
  counterRole: AccountRole
  headAccountId: string | null
}

/**
 * Build the balanced posting lines for a bank transaction. Exactly one of
 * debit (outflow) / credit (inflow) is expected to be non-zero; the caller has
 * already validated that. Returns [] when there is nothing postable.
 */
export function buildBankTransactionLines(
  txn: Record<string, any>,
  ctx: BankPostContext,
): Parameters<typeof postLines>[0] {
  const inflow = round2(num(txn.credit))
  const outflow = round2(num(txn.debit))
  const gst = round2(num(txn.gst_amount))
  const tds = round2(num(txn.tds_amount))
  const isTransfer = String(txn.transaction_type ?? "").trim() === "Transfer"

  const lines: Parameters<typeof postLines>[0] = []

  if (isTransfer && txn.counter_account_id) {
    // Money leaving THIS account funds the counter account (and vice-versa).
    if (outflow > 0) {
      lines.push({ role: ctx.counterRole, debit: outflow, credit: 0 })
      lines.push({ role: ctx.bankRole, debit: 0, credit: outflow })
    } else if (inflow > 0) {
      lines.push({ role: ctx.bankRole, debit: inflow, credit: 0 })
      lines.push({ role: ctx.counterRole, debit: 0, credit: inflow })
    }
    return lines
  }

  // Non-transfer needs an explicit contra (account head) to balance against.
  if (!ctx.headAccountId) return lines
  if (inflow > 0) {
    lines.push({ role: ctx.bankRole, debit: inflow, credit: 0 })
    lines.push({ role: ctx.bankRole, accountId: ctx.headAccountId, debit: 0, credit: inflow, gst, tds })
  } else if (outflow > 0) {
    lines.push({ role: ctx.bankRole, accountId: ctx.headAccountId, debit: outflow, credit: 0, gst, tds })
    lines.push({ role: ctx.bankRole, debit: 0, credit: outflow })
  }
  return lines
}

/** Post a bank transaction to the Journal + General Ledger (or reverse it). */
export async function postBankTransaction(
  txn: Record<string, any>,
  opts: { createdBy?: number | null; reverse?: boolean } = {},
): Promise<PostingResult> {
  const bankRole = bankRoleForType(await financeAccountType(txn.bank_cash_account_id))
  const counterRole = bankRoleForType(await financeAccountType(txn.counter_account_id))
  const lines = buildBankTransactionLines(txn, {
    bankRole,
    counterRole,
    headAccountId: txn.account_head_id ? String(txn.account_head_id) : null,
  })
  if (lines.length === 0) throw new Error("Bank transaction has no postable amount / contra account")

  const ref = String(txn.transaction_id || txn.id)
  return postLines(lines, {
    entityType: "bank_transaction",
    entityId: Number(txn.id),
    entityRef: ref,
    date: String(txn.transaction_date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    financialYear: txn.financial_year ?? null,
    partyId: txn.party_id || null,
    partyName: txn.party_name || null,
    projectId: txn.project_id || null,
    projectName: txn.project_name || null,
    voucherType: txn.voucher_type || (txn.transaction_type === "Receipt" ? "Receipt" : "Bank"),
    narration: opts.reverse
      ? `Reversal of bank transaction ${ref}`
      : `${txn.transaction_type || "Bank"} ${ref}${txn.party_name ? ` — ${txn.party_name}` : ""}`,
    sourceModule: "Bank Transaction",
    createdBy: opts.createdBy ?? null,
    reverse: opts.reverse,
  })
}

/**
 * Whether a transaction currently has a postable contra. A transfer needs a
 * counter account; everything else needs a resolvable account head. Used so a
 * row that can't yet balance is left Unposted instead of throwing.
 */
async function hasPostableContra(txn: Record<string, any>): Promise<boolean> {
  if (String(txn.transaction_type ?? "").trim() === "Transfer") return !!txn.counter_account_id
  if (!txn.account_head_id) return false
  return (await resolveAccountById(String(txn.account_head_id))) !== null
}

/** Frozen copy of the fields a reversal must unwind (never the edited amounts). */
function snapshotOf(t: Record<string, any>) {
  return {
    id: t.id,
    transaction_id: t.transaction_id,
    transaction_date: t.transaction_date,
    financial_year: t.financial_year,
    transaction_type: t.transaction_type,
    voucher_type: t.voucher_type,
    bank_cash_account_id: t.bank_cash_account_id,
    counter_account_id: t.counter_account_id,
    account_head_id: t.account_head_id,
    party_id: t.party_id,
    party_name: t.party_name,
    project_id: t.project_id,
    project_name: t.project_name,
    debit: num(t.debit),
    credit: num(t.credit),
    gst_amount: num(t.gst_amount),
    tds_amount: num(t.tds_amount),
  }
}

/**
 * Idempotently keep a bank transaction's Journal + General Ledger posting in
 * sync with its stored amounts. Keyed off `voucher_no` + `posted_amount`:
 *   - nothing postable (zero amount, unpostable status, no contra) → reverse
 *     any existing voucher and clear the posting columns;
 *   - already posted with the same amount → no-op (never double-posts);
 *   - amount changed on a posted row → reverse the old voucher, post fresh;
 *   - not yet posted → post and stamp the voucher onto the row.
 *
 * Failure-tolerant: a posting error leaves the row "Unposted" for retry and
 * never blocks bank-transaction CRUD.
 */
export async function syncBankTransactionPosting(
  transactionId: string,
  opts: { createdBy?: number | null } = {},
): Promise<{ action: "posted" | "reposted" | "reversed" | "skipped" | "error"; voucherNo?: string }> {
  const [txn] = (await query(`SELECT * FROM bank_transactions WHERE transaction_id = ? LIMIT 1`, [
    transactionId,
  ])) as any[]
  if (!txn) return { action: "skipped" }

  const amount = round2(Math.max(num(txn.credit), num(txn.debit)))
  const status = String(txn.reconciliation_status || "").trim()
  const existingVoucher = txn.voucher_no ? String(txn.voucher_no) : null
  const postedAmount = round2(num(txn.posted_amount))

  let postedSnapshot: Record<string, any> = txn
  if (txn.posted_snapshot) {
    try {
      postedSnapshot = { ...JSON.parse(String(txn.posted_snapshot)), id: txn.id, transaction_id: txn.transaction_id }
    } catch {
      postedSnapshot = txn
    }
  }

  const reverseExisting = async () => {
    if (!existingVoucher) return
    await postBankTransaction(postedSnapshot, { createdBy: opts.createdBy ?? null, reverse: true })
    await query(
      `UPDATE bank_transactions
          SET reversal_voucher_no = ?, voucher_no = NULL, posting_status = 'Unposted',
              posted_amount = 0, posted_snapshot = NULL
        WHERE id = ?`,
      [existingVoucher, txn.id],
    )
  }

  try {
    const postable = amount > 0 && !UNPOSTABLE_STATUSES.has(status) && (await hasPostableContra(txn))

    // Nothing postable → unwind any prior posting.
    if (!postable) {
      if (existingVoucher) {
        await reverseExisting()
        return { action: "reversed" }
      }
      return { action: "skipped" }
    }

    // Already posted and unchanged → idempotent no-op.
    if (existingVoucher && Math.abs(postedAmount - amount) <= 0.01) {
      return { action: "skipped", voucherNo: existingVoucher }
    }

    // Amount changed on a posted row → reverse then re-post.
    let reposted = false
    if (existingVoucher) {
      await reverseExisting()
      reposted = true
    }

    const result = await postBankTransaction(txn, { createdBy: opts.createdBy ?? null })
    await query(
      `UPDATE bank_transactions
          SET voucher_no = ?, journal_entry_id = ?, posting_status = 'Posted', posted_at = NOW(),
              posted_amount = ?, posted_snapshot = ?
        WHERE id = ?`,
      [result.voucherNo, result.journalEntryIds[0] ?? null, amount, JSON.stringify(snapshotOf(txn)), txn.id],
    )
    return { action: reposted ? "reposted" : "posted", voucherNo: result.voucherNo }
  } catch (error) {
    console.log("[v0] bank transaction posting failed for", transactionId, (error as Error)?.message)
    await query(`UPDATE bank_transactions SET posting_status = 'Unposted' WHERE id = ?`, [txn.id]).catch(() => {})
    return { action: "error" }
  }
}

/** Reverse and clear a bank transaction's posting (used when the row is deleted). */
export async function reverseBankTransactionPosting(txn: Record<string, any>): Promise<void> {
  if (!txn?.voucher_no) return
  let toReverse: Record<string, any> = txn
  if (txn.posted_snapshot) {
    try {
      toReverse = { ...JSON.parse(String(txn.posted_snapshot)), id: txn.id, transaction_id: txn.transaction_id }
    } catch {
      toReverse = txn
    }
  }
  try {
    await postBankTransaction(toReverse, { reverse: true })
  } catch (error) {
    console.log("[v0] bank transaction reversal failed for", txn?.transaction_id, (error as Error)?.message)
  }
}
