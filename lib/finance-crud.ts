import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { nextRecordId } from "@/lib/record-ids"
import { nextRecordIdForPrefix } from "@/lib/settings/numbering"
import { FINANCE_MODULE_CONFIGS } from "@/lib/finance-module-configs"
import type { ModuleConfig } from "@/lib/finance-schema"
import { ensureFreelanceInvoiceColumns, ensureFteInvoiceColumns, ensureCustomerVendorGstColumns, ensurePurchaseBillColumns, ensureExpenseColumns, ensureBankTransactionColumns, ensureChartOfAccountsColumns, ensureRegisterModuleTables, ensureLoansAdvancesColumns, ensureBudgetSchema } from "@/lib/finance-ensure"
import { syncRegisterPosting, reverseRegisterPosting } from "@/lib/finance-register-posting"
import { augmentLoanAdvance, syncLoanSchedule, deleteLoanSchedule } from "@/lib/finance-loans"
import { syncProvisionSchedule, deleteProvisionSchedule } from "@/lib/finance-provisions"
import { guardChartOfAccountWrite, checkAccountDeletable } from "@/lib/finance-coa"
import { syncOpeningBalancePosting } from "@/lib/finance-opening-balance"
import { nextPurchaseBillId, computePurchaseBillServerFields } from "@/lib/finance-purchase-bills"
import { nextExpenseId, computeExpenseServerFields, validateExpense, findDuplicateExpense } from "@/lib/finance-expenses"
import { nextBankTransactionId, syncBankTransactionPosting, reverseBankTransactionPosting } from "@/lib/finance-bank-posting"
import { nextFinanceAccountId, recomputeAccountBalance, recomputeBalancesForBankTxn } from "@/lib/finance-account-master"
import { guardBankTransactionWrite, guardBankAccountClose } from "@/lib/finance-bank-guards"
import { logFinanceEvent } from "@/lib/finance-audit"
import {
  ensureProcurementSchema,
  guardRequisitionWrite,
  guardRfqWrite,
  guardPoWrite,
  guardGrnWrite,
  afterRequisitionWrite,
  afterRfqWrite,
  afterPoWrite,
  afterGrnWrite,
} from "@/lib/finance-procurement"
import { assertPeriodOpen, PeriodLockedError } from "@/lib/finance-period-lock"
import {
  syncGstInputForBill,
  deleteGstInputForBill,
  syncGstInputForExpense,
  deleteGstInputForExpense,
} from "@/lib/finance-gst-input"
import { syncPurchaseBillPosting, reversePurchaseBillPosting } from "@/lib/finance-posting"
import { syncExpensePosting, reverseExpensePosting } from "@/lib/finance-expense-posting"
import { computeBillItems, persistBillItems } from "@/lib/purchase-bill-items"
import type { SupplyType } from "@/lib/sales-invoice-compute"
import { INVOICE_WORKFLOW_MODULES, scopeAndAnnotateInvoices, snapshotInvoiceManager } from "@/lib/finance-invoice-workflow"
import {
  FINANCE_PERMISSION_KEYS,
  scopeWhereForModule,
  mergeScopeIntoWhere,
  canActOnRecord,
  canCreateInModule,
} from "@/lib/permission-enforce"

/**
 * Optional per-module server augmentation. Runs AFTER the pure `compute`, can
 * touch the database (vendor snapshot, company settings) and its output is
 * authoritative — it overrides anything the browser sent. Kept here (server
 * only) rather than in the shared config module so server imports never leak
 * into the client bundle.
 */
const SERVER_AUGMENT: Record<
  string,
  (merged: Record<string, any>, opts: { isCreate: boolean }) => Promise<Record<string, any>>
> = {
  "purchase-bills": computePurchaseBillServerFields,
  expenses: computeExpenseServerFields,
  // Phase 4 — fill the type-implied direction, EMI / end date / total interest
  // and seed the split outstanding balances authoritatively.
  "loans-advances": augmentLoanAdvance,
}

/** Optional per-module custom business-key generator (Phase 1: PB-2026-000001). */
const ID_GENERATORS: Record<string, (record: Record<string, any>) => Promise<string>> = {
  "purchase-bills": (record) => nextPurchaseBillId(record.bill_date),
  expenses: (record) => nextExpenseId(record.expense_date),
  // FY-scoped, concurrency-safe Bank Transaction id (BT-2026-000001). Never the
  // generic MAX+1 prefix — see lib/finance-bank-posting.nextBankTransactionId.
  "bank-transactions": (record) => nextBankTransactionId(record.transaction_date),
  // Per-type Bank & Cash account id (BANK-0001 / CASH-0001 / WALLET-0001 /
  // UPI-0001). Existing ACC- ids are immutable and never rewritten.
  "bank-cash": (record) => nextFinanceAccountId(record.account_type),
}

/**
 * Guard a bank transaction's debit/credit before it is written (Phase 8/9). A
 * movement carries exactly one side — entering both debit and credit by hand
 * would create an unbalanced, meaningless row — and a manual entry needs an
 * amount. Imported statement rows bypass this (they come through the importer,
 * not the CRUD POST) so a raw uncategorised line can still land as a draft.
 */
function validateBankTransaction(merged: Record<string, any>): string | null {
  const debit = Number(merged.debit) || 0
  const credit = Number(merged.credit) || 0
  if (debit > 0 && credit > 0) return "A bank transaction can carry either a debit or a credit — not both."
  if (debit < 0 || credit < 0) return "Debit and credit amounts cannot be negative."
  if (debit === 0 && credit === 0) return "Enter a debit (withdrawal) or a credit (deposit) amount."
  return null
}

/**
 * Optional per-module hard validation (Phase 25). Runs on the merged record
 * BEFORE the augment/write; returning a string rejects the request with 400.
 */
const VALIDATORS: Record<string, (merged: Record<string, any>) => string | null> = {
  expenses: validateExpense,
  "bank-transactions": validateBankTransaction,
}

/**
 * Optional per-module duplicate guard (Phase 24). Runs on create only, after
 * the augment, unless the client sent `__forceCreate`. A hit returns 409 with a
 * `duplicate` payload so the form can ask the user to confirm.
 */
const DUPLICATE_CHECKS: Record<
  string,
  (merged: Record<string, any>) => Promise<{ expense_id: string; reason: string } | null>
> = {
  expenses: (merged) => findDuplicateExpense(merged, null),
}

/**
 * Optional per-module ASYNC guard (period lock, cross-record status checks).
 * Runs on both create and edit AFTER the sync validator and augment, but before
 * the write. Returning a string rejects the request with 400. Unlike VALIDATORS
 * these may touch the database (e.g. read another account's status).
 */
const ASYNC_GUARDS: Record<
  string,
  (merged: Record<string, any>, ctx: { isCreate: boolean; existing: Record<string, any> | null }) => Promise<string | null>
> = {
  "bank-transactions": (merged) => guardBankTransactionWrite(merged),
  "bank-cash": (merged, ctx) => guardBankAccountClose(merged, ctx.existing),
  "chart-of-accounts": (merged, ctx) => guardChartOfAccountWrite(merged, ctx),
  // SPEC 136 procurement guards — segregation of duties on approval, budget
  // limits, chain linking (approved requisition / awarded RFQ / approved PO)
  // and cancellation rules. All decisions are pure (finance-procurement-rules).
  "purchase-requisition": (merged, ctx) => guardRequisitionWrite(merged, ctx),
  "rfq": (merged, ctx) => guardRfqWrite(merged, ctx),
  "purchase-orders": (merged, ctx) => guardPoWrite(merged, ctx),
  "goods-receipt": (merged, ctx) => guardGrnWrite(merged, ctx),
}

/** SPEC 136 — the four procurement document modules (shared table ensure). */
const PROCUREMENT_MODULE_KEYS = new Set<string>([
  "purchase-requisition",
  "rfq",
  "purchase-orders",
  "goods-receipt",
])

/**
 * Optional per-module delete guard. Runs in DELETE after the row is loaded but
 * BEFORE it is removed; returning a string rejects with 409 so the client can
 * surface why (e.g. a Chart of Accounts head still referenced by the ledger).
 */
const DELETE_GUARDS: Record<string, (row: Record<string, any>) => Promise<string | null>> = {
  "chart-of-accounts": async (row) => {
    const result = await checkAccountDeletable(row)
    return result.ok ? null : result.reason ?? "This account cannot be deleted."
  },
}

/**
 * Optional per-module side effect that runs AFTER a create/update has been
 * committed to the module's own table. For Purchase Bills this is where the
 * frozen line-item snapshot is persisted (Phase 6/7) and the bill is projected
 * into the GST Input / ITC register (Phase 11–20). Everything here keys off the
 * authoritative, server-recomputed row, never the raw browser payload.
 */
// The five transactional register modules that project a balanced double-entry
// voucher (Journal + General Ledger) through the shared register-posting engine.
// Related Parties is a plain disclosure master and never posts. This set drives
// both the on-demand table ensure and the generic post/reverse hooks below, so
// the Balance Sheet, Trial Balance and Fixed Assets Register reflect them.
const REGISTER_POSTING_KEYS = [
  "fixed-assets",
  "loans-advances",
  "investments",
  "provisions-accruals",
  "capital-equity",
] as const

/** Every register module that owns a dedicated table (posting + the RP master). */
const REGISTER_MODULE_KEYS = new Set<string>([...REGISTER_POSTING_KEYS, "related-parties"])

const AFTER_WRITE: Record<
  string,
  (ctx: {
    finalRow: Record<string, any>
    body: Record<string, any>
    userId: number
    isCreate: boolean
    existing: Record<string, any> | null
  }) => Promise<void>
> = {
  // Requirements 14/15 — an account's opening balance is projected into a real,
  // balanced double-entry voucher (Journal + General Ledger) with the contra on
  // the system "Opening Balance Equity" head. Idempotent and failure-tolerant:
  // creating with an opening balance posts it, editing the amount/side reverses
  // and re-posts, clearing it reverses, and a posting error never blocks COA
  // CRUD (the next save retries).
  "chart-of-accounts": async ({ finalRow, userId }) => {
    const accountId = finalRow[cfgIdColumn("chart-of-accounts")]
    if (!accountId) return
    try {
      await syncOpeningBalancePosting(String(accountId), { createdBy: userId })
    } catch (error) {
      console.log("[v0] syncOpeningBalancePosting failed:", (error as Error).message)
    }
  },
  // SPEC 136 — procurement status propagation + audit. Failure-tolerant so a
  // side-effect error never blocks the primary document write.
  "purchase-requisition": async (ctx) => {
    try {
      await afterRequisitionWrite(ctx)
    } catch (error) {
      console.log("[v0] afterRequisitionWrite failed:", (error as Error).message)
    }
  },
  "rfq": async (ctx) => {
    try {
      await afterRfqWrite(ctx)
    } catch (error) {
      console.log("[v0] afterRfqWrite failed:", (error as Error).message)
    }
  },
  "purchase-orders": async (ctx) => {
    try {
      await afterPoWrite(ctx)
    } catch (error) {
      console.log("[v0] afterPoWrite failed:", (error as Error).message)
    }
  },
  "goods-receipt": async (ctx) => {
    try {
      await afterGrnWrite(ctx)
    } catch (error) {
      console.log("[v0] afterGrnWrite failed:", (error as Error).message)
    }
  },
  "purchase-bills": async ({ finalRow, body, userId }) => {
    const billId = finalRow[cfgIdColumn("purchase-bills")]
    if (!billId) return
    // Persist the frozen multi-line snapshot when the client sent line items.
    const raw = Array.isArray(body.__items) ? (body.__items as any[]) : null
    if (raw && raw.length > 0) {
      const supplyType = (finalRow.supply_type as SupplyType) || "Intra-State"
      const { items } = computeBillItems(raw, supplyType)
      await persistBillItems(String(billId), items)
    }
    // Project into the ITC register (idempotent: create → edit → re-post never
    // duplicates a credit, and a zero-GST / excluded bill removes its record).
    await syncGstInputForBill(String(billId), { createdBy: userId })
    // Project into the Journal + General Ledger (Phases 33–37). Idempotent and
    // failure-tolerant — a posting error leaves the bill "Unposted" and the next
    // save retries, so it never blocks bill CRUD.
    await syncPurchaseBillPosting(String(billId), { createdBy: userId })
  },
  // Phase 7/40 — after an expense is committed, project its eligible input GST
  // into the SAME centralized GST Input register (idempotent; a zero-GST or
  // rejected expense removes any record). The user never enters GST Input by
  // hand. Failure-tolerant so it never blocks expense CRUD.
  expenses: async ({ finalRow, userId }) => {
    const expenseId = finalRow[cfgIdColumn("expenses")]
    if (!expenseId) return
    try {
      await syncGstInputForExpense(String(expenseId), { createdBy: userId })
    } catch (error) {
      console.log("[v0] syncGstInputForExpense failed:", (error as Error).message)
    }
    // Project into the Journal + General Ledger. Idempotent and failure-tolerant:
    // the posting engine only posts an Approved/Posted expense and no-ops for a
    // draft/pending/rejected one, so editing an already-approved expense keeps
    // its accrual in sync while a posting error leaves it "Unposted" for retry.
    try {
      await syncExpensePosting(String(expenseId), { createdBy: userId })
    } catch (error) {
      console.log("[v0] syncExpensePosting failed:", (error as Error).message)
    }
  },
  // A committed Bank Transaction is projected into the SAME Journal + General
  // Ledger engine as every other finance document (Phases 14–17). Posting is
  // idempotent and failure-tolerant: a row with no resolvable contra (e.g. a
  // freshly imported statement line) stays "Unposted" for later classification,
  // an amount change reverses-and-reposts, and a posting error never blocks the
  // CRUD write. Both legs of a bank-to-bank transfer share one `transfer_id`
  // for traceability (Phases 20/98–100); the balanced transfer journal already
  // covers both accounts, so only this row posts — never a duplicate.
  "bank-transactions": async ({ finalRow, userId }) => {
    const txnId = finalRow[cfgIdColumn("bank-transactions")]
    if (!txnId) return
    if (String(finalRow.transaction_type) === "Transfer" && !finalRow.transfer_id) {
      await query(
        `UPDATE bank_transactions SET transfer_id = ?
           WHERE transaction_id = ? AND (transfer_id IS NULL OR transfer_id = '')`,
        [`TRF-${txnId}`, txnId],
      ).catch(() => {})
    }
    try {
      await syncBankTransactionPosting(String(txnId), { createdBy: userId })
    } catch (error) {
      console.log("[v0] syncBankTransactionPosting failed:", (error as Error).message)
    }
    // Keep the affected accounts' authoritative Book Balance live after any
    // create / edit. Recomputes from the committed row's account(s).
    await recomputeBalancesForBankTxn(finalRow)
  },
  // A Bank & Cash account's Book Balance is server-authoritative — recompute it
  // from the account's own transactions after every create / edit so an edited
  // opening balance (or a fresh account) immediately reflects the correct book
  // balance and reconciliation difference.
  "bank-cash": async ({ finalRow, existing, isCreate, userId }) => {
    const accountId = String(finalRow[cfgIdColumn("bank-cash")] ?? existing?.finance_account_id ?? "").trim()
    if (!accountId) return
    await recomputeAccountBalance(accountId)

    // Audit the account lifecycle (create / rename / close / reopen). Read the
    // committed row so the numeric pk and post-write state are authoritative.
    const [row] = (await query(
      `SELECT id, account_name, active_status FROM finance_accounts WHERE finance_account_id = ? LIMIT 1`,
      [accountId],
    )) as any[]
    if (!row) return
    const base = {
      entityType: "finance_account",
      entityPk: Number(row.id),
      entityRef: accountId,
      actorId: userId,
    }
    if (isCreate) {
      await logFinanceEvent({ ...base, type: "created", summary: `Account ${accountId} created`, detail: { name: row.account_name } })
      return
    }
    if (!existing) return
    const oldStatus = String(existing.active_status ?? "")
    const newStatus = String(row.active_status ?? "")
    if (oldStatus !== newStatus) {
      const type = newStatus === "Closed" ? "cancelled" : oldStatus === "Closed" ? "reopened" : "updated"
      await logFinanceEvent({ ...base, type, summary: `Status changed ${oldStatus || "—"} → ${newStatus || "—"}`, detail: { from: oldStatus, to: newStatus } })
    }
    if (String(existing.account_name ?? "") !== String(row.account_name ?? "")) {
      await logFinanceEvent({ ...base, type: "updated", summary: `Renamed to ${row.account_name}`, detail: { from: existing.account_name, to: row.account_name } })
    }
  },
  // Fixed Assets, Loans & Advances, Investments, Provisions & Accruals and
  // Capital & Equity all project a balanced double-entry voucher through the
  // shared register-posting engine, so their balances flow into the Journal,
  // General Ledger, Trial Balance, Balance Sheet and Fixed Assets Register.
  // Posting is idempotent and failure-tolerant: only an active/approved status
  // posts, an amount change reverses-and-reposts, and a posting error leaves the
  // document "Unposted" for the next save to retry — it never blocks CRUD.
  ...Object.fromEntries(
    REGISTER_POSTING_KEYS.map((key) => [
      key,
      async ({ finalRow, userId }: { finalRow: Record<string, any>; userId: number }) => {
        const businessId = finalRow[cfgIdColumn(key)]
        if (!businessId) return
        try {
          await syncRegisterPosting(key, String(businessId), { createdBy: userId })
        } catch (error) {
          console.log(`[v0] syncRegisterPosting failed for ${key}:`, (error as Error).message)
        }
      },
    ]),
  ),
  // Loans & Advances posts its principal like the other registers, and then
  // regenerates its persisted amortisation schedule (EMI + principal/interest
  // split + running outstanding) from the recomputed row. Overrides the generic
  // register hook above (declared later, so it wins). Failure-tolerant.
  "loans-advances": async ({ finalRow, userId }) => {
    const loanId = finalRow[cfgIdColumn("loans-advances")]
    if (!loanId) return
    try {
      await syncRegisterPosting("loans-advances", String(loanId), { createdBy: userId })
    } catch (error) {
      console.log("[v0] syncRegisterPosting failed for loans-advances:", (error as Error).message)
    }
    try {
      await syncLoanSchedule(String(loanId))
    } catch (error) {
      console.log("[v0] syncLoanSchedule failed:", (error as Error).message)
    }
  },
  // Provisions & Accruals posts its one-off recognition like the other
  // registers, then (re)builds its periodic-posting schedule — prepaid
  // amortisation and recurring provision/accrual installments — from the
  // recomputed row. Overrides the generic register hook above. Failure-tolerant.
  "provisions-accruals": async ({ finalRow, userId }) => {
    const provisionId = finalRow[cfgIdColumn("provisions-accruals")]
    if (!provisionId) return
    try {
      await syncRegisterPosting("provisions-accruals", String(provisionId), { createdBy: userId })
    } catch (error) {
      console.log("[v0] syncRegisterPosting failed for provisions-accruals:", (error as Error).message)
    }
    try {
      await syncProvisionSchedule(String(provisionId))
    } catch (error) {
      console.log("[v0] syncProvisionSchedule failed:", (error as Error).message)
    }
  },
}

/** Optional per-module side effect that runs when a record is deleted. */
const AFTER_DELETE: Record<string, (row: Record<string, any>) => Promise<void>> = {
  "purchase-bills": async (row) => {
    const billId = row?.bill_id
    if (!billId) return
    // Reverse the accounting posting first so the ledger stays balanced, then
    // unwind the dependent registers.
    await reversePurchaseBillPosting(row)
    await deleteGstInputForBill(String(billId))
    await query(`DELETE FROM purchase_bill_items WHERE bill_id = ?`, [billId])
  },
  // Unwind the expense's projected ITC record when it is deleted.
  expenses: async (row) => {
    const expenseId = row?.expense_id
    if (!expenseId) return
    // Reverse any accounting posting first so the ledger stays balanced, then
    // unwind the dependent ITC register.
    try {
      await reverseExpensePosting(String(expenseId), { createdBy: null })
    } catch (error) {
      console.log("[v0] reverseExpensePosting failed:", (error as Error).message)
    }
    await deleteGstInputForExpense(String(expenseId))
  },
  // Reverse the transaction's Journal + General Ledger posting before the row
  // leaves so the ledger stays balanced (the reversal unwinds the frozen
  // `posted_snapshot`, never the possibly-edited live amounts).
  "bank-transactions": async (row) => {
    try {
      await reverseBankTransactionPosting(row)
    } catch (error) {
      console.log("[v0] reverseBankTransactionPosting failed:", (error as Error).message)
    }
    // The row is already gone; recompute the affected accounts so their Book
    // Balance no longer counts the deleted movement.
    await recomputeBalancesForBankTxn(row)
  },
  // Reverse a register document's Journal + General Ledger posting before the
  // row leaves so the ledger stays balanced (the reversal unwinds the frozen
  // `posted_snapshot`, never the possibly-edited live amounts).
  ...Object.fromEntries(
    REGISTER_POSTING_KEYS.map((key) => [
      key,
      async (row: Record<string, any>) => {
        try {
          await reverseRegisterPosting(key, row)
        } catch (error) {
          console.log(`[v0] reverseRegisterPosting failed for ${key}:`, (error as Error).message)
        }
      },
    ]),
  ),
  // Loans & Advances additionally owns a persisted amortisation schedule, so its
  // delete must unwind the ledger posting AND drop the schedule rows. Declared
  // after the generic register spread above so it wins. Failure-tolerant.
  "loans-advances": async (row) => {
    try {
      await reverseRegisterPosting("loans-advances", row)
    } catch (error) {
      console.log("[v0] reverseRegisterPosting failed for loans-advances:", (error as Error).message)
    }
    try {
      await deleteLoanSchedule(String(row?.loan_id ?? ""))
    } catch (error) {
      console.log("[v0] deleteLoanSchedule failed:", (error as Error).message)
    }
  },
  // Provisions & Accruals additionally owns a periodic-posting schedule, so its
  // delete must unwind the recognition posting AND reverse + drop every posted
  // periodic voucher. Declared after the generic register spread. Failure-tolerant.
  "provisions-accruals": async (row) => {
    try {
      await reverseRegisterPosting("provisions-accruals", row)
    } catch (error) {
      console.log("[v0] reverseRegisterPosting failed for provisions-accruals:", (error as Error).message)
    }
    try {
      await deleteProvisionSchedule(String(row?.provision_id ?? ""))
    } catch (error) {
      console.log("[v0] deleteProvisionSchedule failed:", (error as Error).message)
    }
  },
}

/** Resolve a module's id column without importing the whole config graph twice. */
function cfgIdColumn(moduleKey: string): string {
  return FINANCE_MODULE_CONFIGS[moduleKey]?.idColumn ?? "id"
}

/**
 * SPEC 162 — Accounting Period Lock (central enforcement).
 *
 * The transactional finance modules whose dated documents feed the Journal /
 * General Ledger. Creating, editing or deleting one of these in a locked
 * accounting month is rejected here at the shared CRUD entry point — in
 * addition to the guards the individual posting engines already enforce — so a
 * signed-off period's trial balance can never move through the generic module
 * route (invoices, bills, expenses, bank movements and the register vouchers).
 * Masters (customers/vendors, chart of accounts, bank & cash accounts) are not
 * period-scoped and are intentionally excluded.
 */
const PERIOD_LOCKED_MODULES = new Set<string>([
  "fte-invoices",
  "freelance-invoices",
  "purchase-bills",
  "expenses",
  "bank-transactions",
  "fixed-assets",
  "loans-advances",
  "investments",
  "provisions-accruals",
  "capital-equity",
])

/**
 * Reject the request when any of the supplied transaction dates falls in a
 * locked accounting period. Guards both the prior date (you cannot touch a
 * document already sealed in a closed month) and the incoming date (you cannot
 * move a document into one). Returns a 409 response to abort with, or null when
 * every date is open. Only applies to the transactional modules above.
 */
async function guardPeriodLock(
  moduleKey: string,
  cfg: ModuleConfig,
  dates: Array<string | null | undefined>,
): Promise<NextResponse | null> {
  if (!PERIOD_LOCKED_MODULES.has(moduleKey) || !cfg.dateColumn) return null
  try {
    for (const d of dates) {
      if (d === undefined || d === null || String(d).trim() === "") continue
      await assertPeriodOpen(String(d))
    }
    return null
  } catch (error) {
    if (error instanceof PeriodLockedError) {
      return NextResponse.json({ error: error.message, period: error.period, locked: true }, { status: 409 })
    }
    throw error
  }
}

/** Column keys a client is allowed to write (everything except computed fields). */
function inputKeys(cfg: ModuleConfig) {
  return cfg.fields.filter((f) => !f.computed).map((f) => f.key)
}

/** Build the shared WHERE clause + args from the request's query params. */
function buildWhere(cfg: ModuleConfig, p: URLSearchParams) {
  const conditions: string[] = []
  const args: any[] = []

  if (cfg.dateColumn) {
    if (p.get("date_from")) { conditions.push(`x.${cfg.dateColumn} >= ?`); args.push(p.get("date_from")) }
    if (p.get("date_to")) { conditions.push(`x.${cfg.dateColumn} <= ?`); args.push(p.get("date_to")) }
    if (p.get("month")) { conditions.push(`MONTH(x.${cfg.dateColumn}) = ?`); args.push(Number(p.get("month"))) }
    if (p.get("year")) { conditions.push(`YEAR(x.${cfg.dateColumn}) = ?`); args.push(Number(p.get("year"))) }
  }
  if (cfg.financialYearColumn && p.get("financial_year")) {
    conditions.push(`x.${cfg.financialYearColumn} = ?`); args.push(p.get("financial_year"))
  }
  for (const f of cfg.filters ?? []) {
    if (f.type === "select" && p.get(f.key)) { conditions.push(`x.${f.key} = ?`); args.push(p.get(f.key)) }
    if (f.type === "number_range") {
      const min = p.get(f.keyMin)
      const max = p.get(f.keyMax)
      if (min !== null && min !== "" && !Number.isNaN(Number(min))) { conditions.push(`x.${f.column} >= ?`); args.push(Number(min)) }
      if (max !== null && max !== "" && !Number.isNaN(Number(max))) { conditions.push(`x.${f.column} <= ?`); args.push(Number(max)) }
    }
  }
  if (p.get("search") && cfg.searchColumns.length) {
    conditions.push("(" + cfg.searchColumns.map((c) => `x.${c} LIKE ?`).join(" OR ") + ")")
    const like = `%${p.get("search")}%`
    cfg.searchColumns.forEach(() => args.push(like))
  }

  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", args }
}

export function createFinanceHandlers(moduleKey: string) {
  const cfg = FINANCE_MODULE_CONFIGS[moduleKey]
  if (!cfg) throw new Error(`Unknown finance module: ${moduleKey}`)
  const keys = inputKeys(cfg)
  // Permission-catalog module this CRUD area maps to, for record-level scoping.
  // Undefined for modules with no ownership dimension (read-only ledgers etc.).
  const permissionKey = FINANCE_PERMISSION_KEYS[moduleKey]

  // Modules with invoice actions carry a few extra columns (recipient email +
  // send tracking) that aren't in the base migration. Self-heal them once.
  const ensureSchema = async () => {
    if (moduleKey === "freelance-invoices") await ensureFreelanceInvoiceColumns()
    if (moduleKey === "fte-invoices") await ensureFteInvoiceColumns()
    if (moduleKey === "customers-vendors") await ensureCustomerVendorGstColumns()
    if (moduleKey === "purchase-bills") await ensurePurchaseBillColumns()
    if (moduleKey === "expenses") await ensureExpenseColumns()
    if (moduleKey === "bank-transactions") await ensureBankTransactionColumns()
    if (moduleKey === "chart-of-accounts") await ensureChartOfAccountsColumns()
    if (REGISTER_MODULE_KEYS.has(moduleKey)) await ensureRegisterModuleTables()
    if (moduleKey === "budgets") await ensureBudgetSchema()
    if (moduleKey === "loans-advances") await ensureLoansAdvancesColumns()
    if (moduleKey === "investments") {
      const { ensureInvestmentSchema } = await import("@/lib/finance-investments")
      await ensureInvestmentSchema()
    }
    if (PROCUREMENT_MODULE_KEYS.has(moduleKey)) await ensureProcurementSchema()
  }

  const validate = VALIDATORS[moduleKey]
  const duplicateCheck = DUPLICATE_CHECKS[moduleKey]
  const asyncGuard = ASYNC_GUARDS[moduleKey]

  const augment = SERVER_AUGMENT[moduleKey]
  const idGenerator = ID_GENERATORS[moduleKey]

  async function GET(req: NextRequest) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    await ensureSchema()
    let { where, args } = buildWhere(cfg, req.nextUrl.searchParams)

    // Record-level permission scope (Add/View/Update/Delete × none/all/added/
    // owned/both). Non-workflow finance modules apply it directly to the list +
    // summary queries so an employee configured with e.g. "added" only sees the
    // rows they created. Invoice-workflow modules keep their bespoke two-stage
    // approval scoping below instead.
    if (permissionKey && !INVOICE_WORKFLOW_MODULES.has(moduleKey)) {
      const scoped = await scopeWhereForModule(session, permissionKey, "view", cfg.table, "x")
      const merged = mergeScopeIntoWhere(where, args, scoped)
      where = merged.where
      args = merged.args
    }

    const orderBy = cfg.dateColumn ? `x.${cfg.dateColumn} DESC, x.id DESC` : "x.id DESC"

    // Opt-in server-side pagination (requirement 111). Backwards compatible:
    // with neither `page` nor `page_size` present the full filtered set is
    // returned exactly as before. Invoice-workflow modules scope their rows in
    // JS AFTER this query, so a DB LIMIT/OFFSET would slice the wrong set —
    // they skip DB pagination and keep their bespoke scoping intact.
    const params = req.nextUrl.searchParams
    const wantsPage = params.get("page") !== null || params.get("page_size") !== null
    const canPaginate = wantsPage && !INVOICE_WORKFLOW_MODULES.has(moduleKey)
    let pagination: { page: number; pageSize: number; total: number; totalPages: number } | null = null
    let limitClause = ""
    if (canPaginate) {
      const pageSize = Math.min(Math.max(Math.trunc(Number(params.get("page_size")) || 50), 1), 500)
      const [cnt] = (await query(`SELECT COUNT(*) n FROM ${cfg.table} x ${where}`, args)) as any[]
      const total = Number(cnt?.n ?? 0)
      const totalPages = Math.max(Math.ceil(total / pageSize), 1)
      const page = Math.min(Math.max(Math.trunc(Number(params.get("page")) || 1), 1), totalPages)
      limitClause = `LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
      pagination = { page, pageSize, total, totalPages }
    }

    let rows = (await query(
      `SELECT x.*, u.name AS created_by_name${cfg.extraSelect ? `, ${cfg.extraSelect}` : ""}
         FROM ${cfg.table} x
         LEFT JOIN users u ON u.id = x.created_by
         ${where}
         ORDER BY ${orderBy}
         ${limitClause}`,
      args,
    )) as any[]

    // Two-stage approval scoping: a regular employee only ever sees invoices
    // where they are the assignee or the assignee's reporting manager, and each
    // surviving row is annotated with its per-user capabilities (`__caps`).
    // Admins (HR / Finance) keep every row with full access.
    let summaryWhere = where
    let summaryArgs = args
    if (INVOICE_WORKFLOW_MODULES.has(moduleKey)) {
      const scoped = await scopeAndAnnotateInvoices(moduleKey, rows, session)
      rows = scoped.rows
      if (!scoped.fullAccess) {
        // Recompute the KPI summary over only the rows this viewer may see so
        // the totals never leak aggregate data about other employees' invoices.
        const ids = rows.map((r) => r.id)
        if (ids.length === 0) {
          summaryWhere = "WHERE 1 = 0"
          summaryArgs = []
        } else {
          summaryWhere = `WHERE x.id IN (${ids.map(() => "?").join(",")})`
          summaryArgs = ids
        }
      }
    }

    const [summary] = (await query(
      `SELECT ${cfg.summarySelect} FROM ${cfg.table} x ${summaryWhere}`,
      summaryArgs,
    )) as any[]

    const financialYears = cfg.financialYearColumn
      ? ((await query(
          `SELECT DISTINCT ${cfg.financialYearColumn} v FROM ${cfg.table}
             WHERE ${cfg.financialYearColumn} IS NOT NULL AND ${cfg.financialYearColumn} <> ''
             ORDER BY v DESC`,
        )) as any[]).map((r) => r.v)
      : []

    return NextResponse.json({ rows, summary: summary ?? {}, filterOptions: { financialYears } })
  }

  // A read-only ledger (e.g. General Ledger) is written ONLY by the posting
  // engine. Reject every hand-made mutation with a clear pointer to the correct
  // entry path, so the ledger can never hold an orphan or unbalanced row.
  const READ_ONLY_MESSAGE =
    "The General Ledger is a read-only ledger of posted transactions. It is written automatically when a journal is posted. To make a manual accounting entry, create a balanced journal in Journal Entries."
  function readOnlyRejection() {
    return NextResponse.json({ error: READ_ONLY_MESSAGE }, { status: 405 })
  }

  async function POST(req: NextRequest) {
    if (cfg.readOnly) return readOnlyRejection()
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    if (permissionKey && !(await canCreateInModule(session, permissionKey))) {
      return NextResponse.json({ error: "You do not have permission to create this record." }, { status: 403 })
    }

    await ensureSchema()
    const body = await req.json()
    const derived = cfg.compute ? cfg.compute(body) : {}

    const record: Record<string, any> = {}
    for (const k of keys) {
      if (k in derived) record[k] = (derived as any)[k]
      else if (body[k] !== undefined && body[k] !== "") record[k] = body[k]
    }
    Object.assign(record, derived)

    // Server-authoritative augmentation (vendor snapshot, place-of-supply GST,
    // due date). Runs on the merged record and overrides browser-sent values.
    if (augment) {
      const extra = await augment({ ...body, ...record }, { isCreate: true })
      for (const k of keys) if (k in extra) record[k] = (extra as any)[k]
      Object.assign(record, extra)
    }

    // Hard validation (Phase 25) on the merged, snapshot-filled record. Runs
    // before the id is minted so a rejected request never burns a sequence.
    if (validate) {
      const message = validate({ ...body, ...record })
      if (message) return NextResponse.json({ error: message }, { status: 400 })
    }

    // Async guard (period lock, closed-account). May read other rows; runs on
    // the merged record before the id is minted so a rejection burns nothing.
    if (asyncGuard) {
      const message = await asyncGuard({ ...body, ...record }, { isCreate: true, existing: null })
      if (message) return NextResponse.json({ error: message }, { status: 400 })
    }

    // Accounting Period Lock (SPEC 162) — reject a new dated document in a
    // locked month before the id is minted so a rejection burns no sequence.
    const createLock = await guardPeriodLock(moduleKey, cfg, [record[cfg.dateColumn ?? ""]])
    if (createLock) return createLock

    // Duplicate guard (Phase 24). Only on create, and only when the client has
    // not already confirmed with `__forceCreate`. A hit returns 409 so the form
    // can surface the existing record and ask the user to confirm.
    if (duplicateCheck && !body.__forceCreate) {
      const hit = await duplicateCheck({ ...body, ...record })
      if (hit) return NextResponse.json({ duplicate: hit }, { status: 409 })
    }

    if (idGenerator) {
      // Custom immutable business key (never client-supplied, concurrency-safe).
      record[cfg.idColumn] = await idGenerator(record)
    } else if (cfg.manualId) {
      if (!body[cfg.idColumn]) return NextResponse.json({ error: `${cfg.idColumn} is required` }, { status: 400 })
      record[cfg.idColumn] = body[cfg.idColumn]
    } else if (cfg.idPrefix) {
      // editableId modules keep a hand-entered business key, but fall back to an
      // auto-generated id whenever the user leaves the field blank.
      const provided = cfg.editableId ? body[cfg.idColumn] : undefined
      record[cfg.idColumn] =
        provided !== undefined && provided !== null && String(provided).trim() !== ""
          ? String(provided).trim()
          : await nextRecordIdForPrefix(cfg.idPrefix)
    }

    if (cfg.trackingId) {
      record.tracking_id = randomUUID()
      record.opened = 0
      record.open_count = 0
    }

    record.created_by = session.userId

    const cols = Object.keys(record)
    await query(
      `INSERT INTO ${cfg.table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((c) => record[c]),
    )

    const afterWrite = AFTER_WRITE[moduleKey]
    if (afterWrite) await afterWrite({ finalRow: record, body, userId: session.userId, isCreate: true, existing: null })

    // Snapshot the assignee's reporting manager for the second approval stage.
    if (INVOICE_WORKFLOW_MODULES.has(moduleKey)) await snapshotInvoiceManager(moduleKey, record)

    return NextResponse.json({ ok: true, id: record[cfg.idColumn] }, { status: 201 })
  }

  async function PATCH(req: NextRequest) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const body = await req.json()
    const id = Number(body.id)
    if (!id) return NextResponse.json({ error: "Record id is required" }, { status: 400 })

    const [existing] = (await query(`SELECT * FROM ${cfg.table} WHERE id = ?`, [id])) as any[]
    if (!existing) return NextResponse.json({ error: "Record not found" }, { status: 404 })

    if (permissionKey && !(await canActOnRecord(session, permissionKey, "update", existing))) {
      return NextResponse.json({ error: "You do not have permission to update this record." }, { status: 403 })
    }

    // Accounting Period Lock (SPEC 162) — block editing a document already
    // sealed in a locked month, and block moving one into a locked month.
    const editLock = await guardPeriodLock(moduleKey, cfg, [
      existing[cfg.dateColumn ?? ""],
      cfg.dateColumn ? body[cfg.dateColumn] : undefined,
    ])
    if (editLock) return editLock

    const merged = { ...existing, ...body }

    // Hard validation (Phase 25) on the merged row before any write.
    if (validate) {
      const message = validate(merged)
      if (message) return NextResponse.json({ error: message }, { status: 400 })
    }

    // Async guard (period lock, closed-account, pre-close balance/reconciliation
    // checks) against the merged row plus its prior committed state.
    if (asyncGuard) {
      const message = await asyncGuard(merged, { isCreate: false, existing })
      if (message) return NextResponse.json({ error: message }, { status: 400 })
    }

    const derived = cfg.compute ? cfg.compute(merged) : {}

    const update: Record<string, any> = {}
    for (const k of keys) {
      if (k === cfg.idColumn && !cfg.manualId) continue
      if (k in derived) update[k] = (derived as any)[k]
      else if (body[k] !== undefined) update[k] = body[k]
    }
    Object.assign(update, derived)

    // Server-authoritative augmentation on the merged row. The immutable id
    // column is never included in the update set (skipped above), so the Bill
    // ID stays frozen across edits.
    if (augment) {
      const extra = await augment({ ...merged, ...derived, ...update }, { isCreate: false })
      for (const k of keys) {
        if (k === cfg.idColumn && !cfg.manualId) continue
        if (k in extra) update[k] = (extra as any)[k]
      }
      for (const [k, v] of Object.entries(extra)) {
        if (k === cfg.idColumn) continue
        update[k] = v
      }
    }

    const cols = Object.keys(update)
    if (cols.length) {
      await query(
        `UPDATE ${cfg.table} SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id=?`,
        [...cols.map((c) => update[c]), id],
      )
    }

    const afterWrite = AFTER_WRITE[moduleKey]
    if (afterWrite) {
      // Re-read the row so the side effect keys off the committed state (the
      // update set only carries changed columns, not the whole bill).
      const [finalRow] = (await query(`SELECT * FROM ${cfg.table} WHERE id = ?`, [id])) as any[]
      if (finalRow) await afterWrite({ finalRow, body, userId: session.userId, isCreate: false, existing })
    }

    // Re-snapshot the reporting manager in case the assignee changed on edit.
    if (INVOICE_WORKFLOW_MODULES.has(moduleKey)) {
      const [finalRow] = (await query(`SELECT * FROM ${cfg.table} WHERE id = ?`, [id])) as any[]
      if (finalRow) await snapshotInvoiceManager(moduleKey, finalRow)
    }

    return NextResponse.json({ ok: true })
  }

  async function DELETE(req: NextRequest) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const id = Number(req.nextUrl.searchParams.get("id"))
    if (!id) return NextResponse.json({ error: "Record id is required" }, { status: 400 })

    // Enforce the delete scope on the specific row. We may need the row for the
    // permission check and/or the side effect, so load it once when either
    // needs it.
    const afterDelete = AFTER_DELETE[moduleKey]
    let doomed: Record<string, any> | null = null
    if (permissionKey || typeof afterDelete === "function" || PERIOD_LOCKED_MODULES.has(moduleKey)) {
      const [row] = (await query(`SELECT * FROM ${cfg.table} WHERE id = ?`, [id])) as any[]
      doomed = row ?? null
    }

    if (permissionKey && doomed && !(await canActOnRecord(session, permissionKey, "delete", doomed))) {
      return NextResponse.json({ error: "You do not have permission to delete this record." }, { status: 403 })
    }

    // Accounting Period Lock (SPEC 162) — a document dated in a locked month
    // cannot be deleted; unlock the period first.
    if (doomed) {
      const deleteLock = await guardPeriodLock(moduleKey, cfg, [doomed[cfg.dateColumn ?? ""]])
      if (deleteLock) return deleteLock
    }

    // Dependency guard (e.g. a Chart of Accounts head still referenced by a
    // child account or the ledger). Load the row if it was not already loaded.
    const deleteGuard = DELETE_GUARDS[moduleKey]
    if (deleteGuard) {
      let subject = doomed
      if (!subject) {
        const [row] = (await query(`SELECT * FROM ${cfg.table} WHERE id = ?`, [id])) as any[]
        subject = row ?? null
      }
      if (subject) {
        const message = await deleteGuard(subject)
        if (message) return NextResponse.json({ error: message }, { status: 409 })
      }
    }

    await query(`DELETE FROM ${cfg.table} WHERE id = ?`, [id])

    if (typeof afterDelete === "function" && doomed) await afterDelete(doomed)

    return NextResponse.json({ ok: true })
  }

  return { GET, POST, PATCH, DELETE }
}
