import "server-only"
import type { PoolConnection } from "mysql2/promise"
import { pool, query } from "@/lib/db"
import { resolveAccountById, isDebitNature, type ResolvedAccount } from "@/lib/finance-accounts"
import { nextLedgerId, ensureGeneralLedgerColumns } from "@/lib/finance-posting"

// ---------------------------------------------------------------------------
// Phase 35 — refreshGeneralLedgerFromFinanceMaster()
//
// The General Ledger is the CENTRAL, derived record of every POSTED accounting
// transaction: Journal Entries (manual + system source-document postings) are
// the primary accounting source, and each posted journal line owns exactly one
// balanced ledger row. The posting engine writes those rows at post time, but a
// transient failure, a partial transaction, a data import, or a schema upgrade
// can leave a posted journal line WITHOUT its ledger row.
//
// This sync reconciles the two: it finds every `Posted` journal line that has
// no matching general_ledger row (keyed on the immutable journal_entry_id) and
// writes the missing row, faithfully reconstructing it from the journal's own
// frozen snapshot (account name/group/type, party, project, amounts, source).
//
// It is safe to run any number of times — on demand, after a bulk import, or on
// a schedule:
//   * ONLY `Posted` journal lines feed the ledger (Draft / Pending / Approved /
//     Rejected / Cancelled / Reversed are ignored — Phase 31).
//   * A line that already has a ledger row is skipped, and the UNIQUE guard on
//     general_ledger.journal_entry_id makes a double-write impossible even under
//     a concurrent run or a retry (Phase 33/34).
//   * The account name / group / type are taken from the journal snapshot, so a
//     later Chart-of-Accounts rename never rewrites historical ledger rows
//     (Phase 39/40).
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export type LedgerSyncResult = {
  scanned: number
  created: number
  skipped: number
  failed: number
  vouchers: number
  errors: string[]
}

/** Read the current signed running balance for an account (in its natural direction). */
async function currentSignedBalance(
  conn: PoolConnection,
  account: { account_id: string; naturalDebit: boolean },
): Promise<number> {
  const [rows] = await conn.query<any[]>(
    `SELECT balance, balance_type FROM general_ledger
       WHERE account_id = ? ORDER BY id DESC LIMIT 1`,
    [account.account_id],
  )
  const last = rows?.[0]
  if (!last) return 0
  const bal = num(last.balance)
  const onNatural = String(last.balance_type || "").toLowerCase() === (account.naturalDebit ? "debit" : "credit")
  return onNatural ? bal : -bal
}

/**
 * Resolve an account's natural (debit-positive) direction. Prefer the live
 * Chart-of-Accounts head; fall back to the journal snapshot's group/nature so a
 * since-archived or since-deleted account still reconstructs with the correct
 * running-balance direction.
 */
async function naturalDebitFor(row: any, cache: Map<string, boolean>): Promise<boolean> {
  const key = String(row.account_id ?? "")
  if (cache.has(key)) return cache.get(key)!
  let resolved: ResolvedAccount | null = null
  if (key) resolved = await resolveAccountById(key).catch(() => null)
  const naturalDebit = resolved
    ? isDebitNature(resolved)
    : isDebitNature({ account_group: row.account_group ?? null, nature: null })
  cache.set(key, naturalDebit)
  return naturalDebit
}

/**
 * Reconcile posted Journal Entries into the General Ledger. Optionally scope to
 * a single voucher (used right after a posting as a belt-and-braces repair).
 */
export async function refreshGeneralLedgerFromFinanceMaster(
  opts: { voucherNo?: string | null } = {},
): Promise<LedgerSyncResult> {
  await ensureGeneralLedgerColumns()

  const result: LedgerSyncResult = { scanned: 0, created: 0, skipped: 0, failed: 0, vouchers: 0, errors: [] }

  // Every POSTED journal line with no ledger row yet, oldest first so running
  // balances rebuild in chronological posting order.
  const conditions = [`je.posting_status = 'Posted'`, `gl.ledger_id IS NULL`]
  const args: any[] = []
  if (opts.voucherNo) {
    conditions.push(`je.voucher_no = ?`)
    args.push(opts.voucherNo)
  }

  const missing = (await query(
    `SELECT je.*
       FROM journal_entries je
       LEFT JOIN general_ledger gl ON gl.journal_entry_id = je.journal_entry_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY je.journal_date ASC, je.id ASC`,
    args,
  )) as any[]

  result.scanned = missing.length
  if (!missing.length) return result

  result.vouchers = new Set(missing.map((r) => String(r.voucher_no || r.journal_entry_id))).size

  const natureCache = new Map<string, boolean>()
  const conn = await pool.getConnection()
  try {
    for (const row of missing) {
      try {
        // Double-check inside the connection: a concurrent post may have written
        // the row since the scan. The UNIQUE guard is the final backstop.
        const [existing] = await conn.query<any[]>(
          `SELECT ledger_id FROM general_ledger WHERE journal_entry_id = ? LIMIT 1`,
          [row.journal_entry_id],
        )
        if (existing.length) {
          result.skipped += 1
          continue
        }

        const naturalDebit = await naturalDebitFor(row, natureCache)
        const debit = round2(num(row.debit))
        const credit = round2(num(row.credit))
        const prev = await currentSignedBalance(conn, { account_id: String(row.account_id ?? ""), naturalDebit })
        const signedDelta = naturalDebit ? debit - credit : credit - debit
        const running = round2(prev + signedDelta)
        const balanceType = running >= 0 ? (naturalDebit ? "Debit" : "Credit") : naturalDebit ? "Credit" : "Debit"
        const ledgerId = await nextLedgerId(row.journal_date)
        const postedOn = row.posting_date ?? row.journal_date

        await conn.query(
          `INSERT INTO general_ledger
             (ledger_id, journal_entry_id, voucher_no, financial_year, transaction_date, value_date, posting_date,
              account_id, account_name, account_group, account_type, transaction_type, voucher_type,
              reference_no, party_id, party_name, project_id, project_name, description, debit, credit,
              amount, gst_amount, tds_amount, balance, balance_type, payment_mode, cheque_utr_reference,
              source_module, source_reference, source_entity_type, source_entity_id, reconciliation_status, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            ledgerId, row.journal_entry_id, row.voucher_no, row.financial_year, row.journal_date, row.journal_date,
            postedOn, row.account_id, row.account_name, row.account_group, row.account_type,
            debit > 0 ? "Debit" : "Credit", row.voucher_type, row.reference_no,
            row.party_id ?? null, row.party_name ?? null, row.project_id ?? null, row.project_name ?? null,
            row.narration ?? null, debit, credit, round2(credit > 0 ? credit : debit),
            round2(num(row.gst_amount)), round2(num(row.tds_amount)), Math.abs(running), balanceType,
            row.payment_mode ?? null, row.cheque_utr_reference ?? null,
            row.source_module ?? null, row.source_reference ?? null,
            row.source_entity_type ?? null, row.source_entity_id ?? null, "Unreconciled", row.created_by ?? null,
          ],
        )
        result.created += 1
      } catch (error: any) {
        // A duplicate-key race means the row now exists — that is the desired
        // idempotent outcome, not a failure.
        if (error?.code === "ER_DUP_ENTRY") {
          result.skipped += 1
          continue
        }
        result.failed += 1
        const ref = String(row.voucher_no || row.journal_entry_id)
        const message = `${ref}: ${(error as Error)?.message || "posting failed"}`
        if (!result.errors.includes(message)) result.errors.push(message)
        console.log("[v0] refreshGeneralLedgerFromFinanceMaster line failed:", message)
      }
    }
  } finally {
    conn.release()
  }

  return result
}
