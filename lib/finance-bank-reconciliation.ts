import "server-only"
import { query } from "@/lib/db"
import { logFinanceEvent } from "@/lib/finance-audit"
import { ensureBankTransactionColumns } from "@/lib/finance-ensure"

// ---------------------------------------------------------------------------
// Bank Transaction reconciliation engine (Phase 31–38, 92–97, 101–102).
//
// Reconciliation is kept LOGICALLY SEPARATE from accounting posting: reconciling
// a bank transaction links it to the finance document it settles and flips its
// reconciliation_status — it never re-posts the Journal/GL (that is owned by
// finance-bank-posting.ts). The two workflows only meet through the shared
// bank_transactions row.
//
// Matching scores a candidate finance_records row against the bank line:
//   Strong    (exact amount + exact reference/UTR)                    → auto-suggest
//   Suggested (exact amount + same party, close date | exact amount + very close date)
//   Weak      (amount only)                                           → manual review
//
// The final link is only applied on explicit user approval via reconcile().
// ---------------------------------------------------------------------------

const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round((num(n) + Number.EPSILON) * 100) / 100
const norm = (v: any) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, "")

export type MatchStrength = "Strong" | "Suggested" | "Weak"

export type MatchCandidate = {
  recordId: number
  reference: string | null
  moduleKey: string | null
  sourceModule: string
  recordDate: string | null
  party: string | null
  amount: number
  outstanding: number | null
  score: number
  strength: MatchStrength
  reasons: string[]
}

/** Map a finance_records module_key to the bank source-module vocabulary. */
const MODULE_TO_SOURCE: Record<string, string> = {
  "sales-invoices": "Sales Invoice",
  "purchase-bills": "Purchase Bill",
  expenses: "Expense",
  "fte-invoices": "FTE",
  "freelance-invoices": "Freelance",
  payments: "Payment",
  "journal-entries": "Journal",
}
function sourceModuleFor(moduleKey?: string | null): string {
  return MODULE_TO_SOURCE[String(moduleKey ?? "")] ?? "Other"
}

function daysBetween(a?: string | null, b?: string | null): number | null {
  if (!a || !b) return null
  const da = new Date(a).getTime()
  const db = new Date(b).getTime()
  if (Number.isNaN(da) || Number.isNaN(db)) return null
  return Math.abs(Math.round((da - db) / 86_400_000))
}

/**
 * Suggest reconciliation matches for one bank transaction. Candidates are drawn
 * from the unified finance_records ledger (all sub-modules), still unreconciled,
 * scored and returned strongest first. Read-only — applies nothing.
 */
export async function suggestMatchesForTransaction(
  transactionId: string,
  opts: { limit?: number } = {},
): Promise<{ transaction: Record<string, any> | null; candidates: MatchCandidate[] }> {
  await ensureBankTransactionColumns()
  const [txn] = (await query(`SELECT * FROM bank_transactions WHERE transaction_id = ? LIMIT 1`, [
    transactionId,
  ])) as any[]
  if (!txn) return { transaction: null, candidates: [] }

  const amount = round2(Math.max(num(txn.debit), num(txn.credit)))
  const ref = norm(txn.cheque_utr_reference) || norm(txn.reference_no)
  const party = norm(txn.party_name)
  const txnDate = txn.transaction_date ? String(txn.transaction_date).slice(0, 10) : null

  // Pull unreconciled ledger rows in the same amount neighbourhood. The amount
  // predicate keeps the candidate set small (no full-table scan / N+1).
  const rows = (await query(
    `SELECT record_id, module_key, reference_no, record_date, party_name, account_name,
            amount, debit, credit, description,
            COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') AS reconciliation_status
       FROM finance_records
      WHERE COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') <> 'Reconciled'
        AND ABS(COALESCE(amount, GREATEST(COALESCE(debit,0), COALESCE(credit,0))) - ?) <= 1
      ORDER BY record_date DESC
      LIMIT 200`,
    [amount],
  )) as any[]

  const candidates: MatchCandidate[] = []
  for (const r of rows) {
    const rAmount = round2(num(r.amount) || Math.max(num(r.debit), num(r.credit)))
    const amountMatch = Math.abs(rAmount - amount) <= 0.5 && amount > 0
    if (!amountMatch) continue

    const rRef = norm(r.reference_no)
    const rParty = norm(r.party_name)
    const gap = daysBetween(txnDate, r.record_date ? String(r.record_date).slice(0, 10) : null)

    let score = 40
    const reasons: string[] = ["Amount match"]
    const refMatch = !!ref && (rRef === ref || rRef.includes(ref) || ref.includes(rRef))
    if (refMatch) {
      score += 45
      reasons.push("Reference / UTR match")
    }
    if (party && rParty && (rParty === party || rParty.includes(party) || party.includes(rParty))) {
      score += 10
      reasons.push("Party match")
    }
    if (gap != null) {
      if (gap <= 2) {
        score += 10
        reasons.push("Same-date")
      } else if (gap <= 7) {
        score += 5
        reasons.push("Close date")
      } else if (gap > 60) {
        score -= 10
      }
    }

    const strength: MatchStrength = score >= 85 ? "Strong" : score >= 60 ? "Suggested" : "Weak"
    candidates.push({
      recordId: Number(r.record_id),
      reference: r.reference_no ?? null,
      moduleKey: r.module_key ?? null,
      sourceModule: sourceModuleFor(r.module_key),
      recordDate: r.record_date ? String(r.record_date).slice(0, 10) : null,
      party: r.party_name ?? null,
      amount: rAmount,
      outstanding: null,
      score: Math.max(0, Math.min(100, score)),
      strength,
      reasons,
    })
  }

  candidates.sort((a, b) => b.score - a.score)
  return { transaction: txn, candidates: candidates.slice(0, opts.limit ?? 10) }
}

export type ReconcileInput = {
  recordId?: number | null
  sourceModule?: string | null
  sourceTransactionId?: string | null
  status?: "Reconciled" | "Pending"
}

/**
 * Apply a reconciliation link to a bank transaction after user approval.
 *
 * Concurrency-safe (Phase 86/87): the status flip is a single conditional
 * UPDATE guarded on the row NOT already being Reconciled, so two users racing to
 * reconcile the same line cannot both win — the loser gets a `conflict`. The
 * matched ledger row is likewise flipped conditionally so one source document
 * cannot be double-consumed.
 */
export async function reconcileTransaction(
  transactionId: string,
  input: ReconcileInput,
  actor: { id?: number | null; name?: string | null } = {},
): Promise<
  | { ok: true; status: string; linkedRecordId: number | null }
  | { ok: false; error: string; code: number }
> {
  await ensureBankTransactionColumns()
  const status = input.status === "Pending" ? "Pending" : "Reconciled"

  const [txn] = (await query(`SELECT * FROM bank_transactions WHERE transaction_id = ? LIMIT 1`, [
    transactionId,
  ])) as any[]
  if (!txn) return { ok: false, error: "Bank transaction not found", code: 404 }
  if (String(txn.reconciliation_status || "") === "Reconciled") {
    return { ok: false, error: "Transaction is already reconciled", code: 409 }
  }

  // Resolve the source link either from an explicit record id or passthrough.
  let sourceModule = input.sourceModule ?? null
  let sourceTransactionId = input.sourceTransactionId ?? null
  let linkedRecordId: number | null = null
  if (input.recordId) {
    const [rec] = (await query(
      `SELECT record_id, module_key, reference_no, reconciliation_status
         FROM finance_records WHERE record_id = ? LIMIT 1`,
      [input.recordId],
    )) as any[]
    if (!rec) return { ok: false, error: "Matched record not found", code: 404 }
    if (String(rec.reconciliation_status || "") === "Reconciled") {
      return { ok: false, error: "That document is already reconciled to another line", code: 409 }
    }
    linkedRecordId = Number(rec.record_id)
    sourceModule = sourceModule ?? sourceModuleFor(rec.module_key)
    sourceTransactionId = sourceTransactionId ?? rec.reference_no ?? null
  }

  // Conditional flip — only succeeds while the row is still unreconciled.
  const result = (await query(
    `UPDATE bank_transactions
        SET reconciliation_status = ?, reconciliation_date = NOW(),
            source_module = COALESCE(?, source_module),
            source_transaction_id = COALESCE(?, source_transaction_id)
      WHERE transaction_id = ? AND COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') <> 'Reconciled'`,
    [status, sourceModule, sourceTransactionId, transactionId],
  )) as any
  if (!result || result.affectedRows === 0) {
    return { ok: false, error: "Transaction was reconciled by another user", code: 409 }
  }

  // Consume the matched ledger row (best effort, also race-guarded).
  if (linkedRecordId != null && status === "Reconciled") {
    await query(
      `UPDATE finance_records
          SET reconciliation_status = 'Reconciled'
        WHERE record_id = ? AND COALESCE(NULLIF(reconciliation_status,''),'Unreconciled') <> 'Reconciled'`,
      [linkedRecordId],
    ).catch(() => {})
  }

  await logFinanceEvent({
    entityType: "bank_transaction",
    entityPk: Number(txn.id),
    entityRef: transactionId,
    type: "updated",
    summary: `${status === "Pending" ? "Marked pending" : "Reconciled"}${sourceModule ? ` against ${sourceModule}` : ""}${sourceTransactionId ? ` ${sourceTransactionId}` : ""}`,
    detail: { action: "reconcile", status, sourceModule, sourceTransactionId, linkedRecordId },
    amount: round2(Math.max(num(txn.debit), num(txn.credit))),
    voucherNo: txn.voucher_no ?? null,
    actorId: actor.id ?? null,
    actorName: actor.name ?? null,
  })

  return { ok: true, status, linkedRecordId }
}

/**
 * Undo a reconciliation link (Phase 72 audit "unreconcile"). Concurrency-safe:
 * only flips a row that is currently reconciled. Releases the linked ledger row
 * so it can be matched again.
 */
export async function unreconcileTransaction(
  transactionId: string,
  actor: { id?: number | null; name?: string | null } = {},
): Promise<{ ok: true } | { ok: false; error: string; code: number }> {
  await ensureBankTransactionColumns()
  const [txn] = (await query(`SELECT * FROM bank_transactions WHERE transaction_id = ? LIMIT 1`, [
    transactionId,
  ])) as any[]
  if (!txn) return { ok: false, error: "Bank transaction not found", code: 404 }
  if (String(txn.reconciliation_status || "") !== "Reconciled") {
    return { ok: false, error: "Transaction is not reconciled", code: 409 }
  }

  const result = (await query(
    `UPDATE bank_transactions
        SET reconciliation_status = 'Unreconciled', reconciliation_date = NULL
      WHERE transaction_id = ? AND reconciliation_status = 'Reconciled'`,
    [transactionId],
  )) as any
  if (!result || result.affectedRows === 0) {
    return { ok: false, error: "Transaction was changed by another user", code: 409 }
  }

  // Release the previously matched ledger row.
  if (txn.source_transaction_id) {
    await query(
      `UPDATE finance_records SET reconciliation_status = 'Unreconciled'
        WHERE reference_no = ? AND reconciliation_status = 'Reconciled'`,
      [txn.source_transaction_id],
    ).catch(() => {})
  }

  await logFinanceEvent({
    entityType: "bank_transaction",
    entityPk: Number(txn.id),
    entityRef: transactionId,
    type: "updated",
    summary: "Unreconciled",
    detail: { action: "unreconcile", previousSource: txn.source_transaction_id ?? null },
    actorId: actor.id ?? null,
    actorName: actor.name ?? null,
  })
  return { ok: true }
}
