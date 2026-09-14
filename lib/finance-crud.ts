import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { nextRecordId } from "@/lib/record-ids"
import { nextRecordIdForPrefix } from "@/lib/settings/numbering"
import { FINANCE_MODULE_CONFIGS } from "@/lib/finance-module-configs"
import type { ModuleConfig } from "@/lib/finance-schema"
import { ensureFreelanceInvoiceColumns, ensureFteInvoiceColumns, ensureCustomerVendorGstColumns, ensurePurchaseBillColumns, ensureExpenseColumns, ensureBankTransactionColumns } from "@/lib/finance-ensure"
import { nextPurchaseBillId, computePurchaseBillServerFields } from "@/lib/finance-purchase-bills"
import { nextExpenseId, computeExpenseServerFields, validateExpense, findDuplicateExpense } from "@/lib/finance-expenses"
import { nextBankTransactionId, syncBankTransactionPosting, reverseBankTransactionPosting } from "@/lib/finance-bank-posting"
import { nextFinanceAccountId, recomputeAccountBalance, recomputeBalancesForBankTxn } from "@/lib/finance-account-master"
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
 * Optional per-module side effect that runs AFTER a create/update has been
 * committed to the module's own table. For Purchase Bills this is where the
 * frozen line-item snapshot is persisted (Phase 6/7) and the bill is projected
 * into the GST Input / ITC register (Phase 11–20). Everything here keys off the
 * authoritative, server-recomputed row, never the raw browser payload.
 */
const AFTER_WRITE: Record<
  string,
  (ctx: { finalRow: Record<string, any>; body: Record<string, any>; userId: number; isCreate: boolean }) => Promise<void>
> = {
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
  "bank-cash": async ({ finalRow }) => {
    const accountId = finalRow[cfgIdColumn("bank-cash")]
    if (accountId) await recomputeAccountBalance(String(accountId))
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
}

/** Resolve a module's id column without importing the whole config graph twice. */
function cfgIdColumn(moduleKey: string): string {
  return FINANCE_MODULE_CONFIGS[moduleKey]?.idColumn ?? "id"
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
  }

  const validate = VALIDATORS[moduleKey]
  const duplicateCheck = DUPLICATE_CHECKS[moduleKey]

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

    let rows = (await query(
      `SELECT x.*, u.name AS created_by_name${cfg.extraSelect ? `, ${cfg.extraSelect}` : ""}
         FROM ${cfg.table} x
         LEFT JOIN users u ON u.id = x.created_by
         ${where}
         ORDER BY ${orderBy}`,
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

  async function POST(req: NextRequest) {
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
    if (afterWrite) await afterWrite({ finalRow: record, body, userId: session.userId, isCreate: true })

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

    const merged = { ...existing, ...body }

    // Hard validation (Phase 25) on the merged row before any write.
    if (validate) {
      const message = validate(merged)
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
      if (finalRow) await afterWrite({ finalRow, body, userId: session.userId, isCreate: false })
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
    if (permissionKey || typeof afterDelete === "function") {
      const [row] = (await query(`SELECT * FROM ${cfg.table} WHERE id = ?`, [id])) as any[]
      doomed = row ?? null
    }

    if (permissionKey && doomed && !(await canActOnRecord(session, permissionKey, "delete", doomed))) {
      return NextResponse.json({ error: "You do not have permission to delete this record." }, { status: 403 })
    }

    await query(`DELETE FROM ${cfg.table} WHERE id = ?`, [id])

    if (typeof afterDelete === "function" && doomed) await afterDelete(doomed)

    return NextResponse.json({ ok: true })
  }

  return { GET, POST, PATCH, DELETE }
}
