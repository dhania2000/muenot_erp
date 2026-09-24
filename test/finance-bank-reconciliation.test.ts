import { beforeEach, describe, expect, it, vi } from "vitest"

// SPEC 166 — Bank Reconciliation. These tests exercise the matching engine and
// the concurrency/immutability contract of the bank-reconciliation workflow
// (lib/finance-bank-reconciliation.ts):
//
//   1. suggestMatchesForTransaction — the read-only scorer that ranks unified
//      ledger rows against one bank line into Strong / Suggested / Weak, applies
//      NOTHING, and returns strongest first.
//   2. Partial matches — a bank line whose amount is only *near* a ledger row is
//      only a candidate inside the tight amount tolerance; anything further out
//      is dropped rather than silently matched.
//   3. Duplicate matches — a reconciled bank line, an already-consumed source
//      document, and a lost race all refuse to double-consume history, and a
//      successful reconcile consumes exactly one ledger row + writes an audit
//      event. Unreconcile releases the linked row again.

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  logFinanceEvent: vi.fn(),
  ensureBankTransactionColumns: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: mocks.query }))
vi.mock("@/lib/finance-audit", () => ({ logFinanceEvent: mocks.logFinanceEvent }))
vi.mock("@/lib/finance-ensure", () => ({ ensureBankTransactionColumns: mocks.ensureBankTransactionColumns }))

import {
  suggestMatchesForTransaction,
  reconcileTransaction,
  unreconcileTransaction,
} from "@/lib/finance-bank-reconciliation"

type Update = { sql: string; args: any[] }

/**
 * Drive the top-level `query` mock. Dispatches by SQL shape so each engine step
 * (bank-line read, single-record lookup, candidate scan, and the two
 * conditional UPDATEs) gets the fixture it expects. Returns the list of UPDATEs
 * issued so a test can assert what was (or was not) mutated.
 */
function setupDb(opts: {
  txn?: Record<string, any> | null
  record?: Record<string, any> | null
  candidates?: any[]
  bankUpdateAffected?: number
  ledgerUpdateAffected?: number
}): Update[] {
  const updates: Update[] = []
  mocks.query.mockImplementation(async (sql: string, args: any[] = []) => {
    if (/^\s*SELECT \* FROM bank_transactions/i.test(sql)) {
      return opts.txn ? [opts.txn] : []
    }
    if (/FROM finance_records\s+WHERE record_id = \?/i.test(sql)) {
      return opts.record ? [opts.record] : []
    }
    if (/FROM finance_records\s+WHERE COALESCE/i.test(sql)) {
      return opts.candidates ?? []
    }
    if (/^\s*UPDATE bank_transactions/i.test(sql)) {
      updates.push({ sql, args })
      return { affectedRows: opts.bankUpdateAffected ?? 1 }
    }
    if (/^\s*UPDATE finance_records/i.test(sql)) {
      updates.push({ sql, args })
      return { affectedRows: opts.ledgerUpdateAffected ?? 1 }
    }
    return []
  })
  return updates
}

const bankLine = (extra: Record<string, any> = {}) => ({
  id: 42,
  transaction_id: "BT-2026-000001",
  debit: 0,
  credit: 1000,
  cheque_utr_reference: "UTR123",
  reference_no: null,
  party_name: "Acme",
  transaction_date: "2026-09-10",
  voucher_no: "V-1",
  reconciliation_status: "Unreconciled",
  source_transaction_id: null,
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.ensureBankTransactionColumns.mockResolvedValue(undefined)
})

describe("suggestMatchesForTransaction — scores and ranks candidates, applies nothing", () => {
  it("classifies Strong / Suggested / Weak and returns them strongest first", async () => {
    setupDb({
      txn: bankLine(),
      candidates: [
        // Weak: amount only, stale date (> 60 days ago) → penalised.
        { record_id: 3, module_key: "expenses", reference_no: "ZZZ", record_date: "2026-06-01", party_name: "Other Co", amount: 1000 },
        // Suggested: amount + party + same-date, but no reference match.
        { record_id: 2, module_key: "payments", reference_no: "OTHER", record_date: "2026-09-11", party_name: "Acme", amount: 1000 },
        // Strong: amount + exact UTR + party + same-date.
        { record_id: 1, module_key: "sales-invoices", reference_no: "UTR123", record_date: "2026-09-10", party_name: "Acme", amount: 1000 },
      ],
    })

    const { candidates } = await suggestMatchesForTransaction("BT-2026-000001")

    expect(candidates.map((c) => c.recordId)).toEqual([1, 2, 3])
    expect(candidates[0].strength).toBe("Strong")
    expect(candidates[0].reasons).toEqual(expect.arrayContaining(["Amount match", "Reference / UTR match"]))
    expect(candidates[1].strength).toBe("Suggested")
    expect(candidates[2].strength).toBe("Weak")

    // Read-only: scoring must never issue an UPDATE.
    expect(mocks.query).not.toHaveBeenCalledWith(expect.stringMatching(/^\s*UPDATE/i), expect.anything())
    expect(mocks.logFinanceEvent).not.toHaveBeenCalled()
  })

  it("uses the larger of debit/credit as the line amount", async () => {
    setupDb({
      txn: bankLine({ debit: 2500, credit: 0, cheque_utr_reference: null }),
      candidates: [{ record_id: 9, module_key: "purchase-bills", reference_no: "X", record_date: "2026-09-10", party_name: "Acme", amount: 2500 }],
    })
    const { candidates } = await suggestMatchesForTransaction("BT-2026-000001")
    expect(candidates).toHaveLength(1)
    expect(candidates[0].amount).toBe(2500)
  })

  it("returns nothing for an unknown bank line", async () => {
    setupDb({ txn: null })
    const res = await suggestMatchesForTransaction("BT-NOPE")
    expect(res.transaction).toBeNull()
    expect(res.candidates).toEqual([])
  })
})

describe("partial matches — only near-exact amounts survive the tolerance", () => {
  it("keeps a row inside the amount tolerance and drops one just outside it", async () => {
    setupDb({
      txn: bankLine({ cheque_utr_reference: null }),
      candidates: [
        // 0.40 away → within the 0.50 reconciliation tolerance.
        { record_id: 10, module_key: "sales-invoices", reference_no: "A", record_date: "2026-09-10", party_name: "Acme", amount: 999.6 },
        // 0.70 away → a partial/near miss, not an automatic candidate.
        { record_id: 11, module_key: "sales-invoices", reference_no: "B", record_date: "2026-09-10", party_name: "Acme", amount: 999.3 },
      ],
    })
    const { candidates } = await suggestMatchesForTransaction("BT-2026-000001")
    expect(candidates.map((c) => c.recordId)).toEqual([10])
  })

  it("never treats a zero-amount line as a match", async () => {
    setupDb({
      txn: bankLine({ debit: 0, credit: 0 }),
      candidates: [{ record_id: 12, module_key: "expenses", reference_no: "C", record_date: "2026-09-10", party_name: "Acme", amount: 0 }],
    })
    const { candidates } = await suggestMatchesForTransaction("BT-2026-000001")
    expect(candidates).toEqual([])
  })
})

describe("duplicate matches — posted reconciliation history is never double-consumed", () => {
  it("reconciles an unmatched line, consumes exactly one ledger row, and audits it", async () => {
    const updates = setupDb({
      txn: bankLine(),
      record: { record_id: 5, module_key: "sales-invoices", reference_no: "INV-1", reconciliation_status: "Unreconciled" },
    })

    const res = await reconcileTransaction("BT-2026-000001", { recordId: 5 }, { id: 7, name: "Alice" })

    expect(res).toMatchObject({ ok: true, status: "Reconciled", linkedRecordId: 5 })
    const ledgerUpdate = updates.find((u) => /UPDATE finance_records/i.test(u.sql))
    expect(ledgerUpdate?.args[0]).toBe(5)
    expect(mocks.logFinanceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ entityRef: "BT-2026-000001", detail: expect.objectContaining({ action: "reconcile" }) }),
    )
  })

  it("refuses to reconcile a bank line that is already reconciled", async () => {
    setupDb({ txn: bankLine({ reconciliation_status: "Reconciled" }) })
    const res = await reconcileTransaction("BT-2026-000001", { recordId: 5 })
    expect(res).toMatchObject({ ok: false, code: 409 })
    expect(mocks.logFinanceEvent).not.toHaveBeenCalled()
  })

  it("refuses to reconcile against a source document already consumed by another line", async () => {
    setupDb({
      txn: bankLine(),
      record: { record_id: 5, module_key: "sales-invoices", reference_no: "INV-1", reconciliation_status: "Reconciled" },
    })
    const res = await reconcileTransaction("BT-2026-000001", { recordId: 5 })
    expect(res).toMatchObject({ ok: false, code: 409 })
    expect(res).toMatchObject({ error: expect.stringMatching(/already reconciled/i) })
  })

  it("loses a concurrent race gracefully when the conditional flip matches no row", async () => {
    setupDb({
      txn: bankLine(),
      record: { record_id: 5, module_key: "sales-invoices", reference_no: "INV-1", reconciliation_status: "Unreconciled" },
      bankUpdateAffected: 0,
    })
    const res = await reconcileTransaction("BT-2026-000001", { recordId: 5 })
    expect(res).toMatchObject({ ok: false, code: 409 })
    expect(res).toMatchObject({ error: expect.stringMatching(/another user/i) })
  })

  it("404s when the matched record does not exist", async () => {
    setupDb({ txn: bankLine(), record: null })
    const res = await reconcileTransaction("BT-2026-000001", { recordId: 999 })
    expect(res).toMatchObject({ ok: false, code: 404 })
  })
})

describe("unreconcile — releases the linked ledger row for re-matching", () => {
  it("unreconciles a reconciled line and frees its source document", async () => {
    const updates = setupDb({
      txn: bankLine({ reconciliation_status: "Reconciled", source_transaction_id: "INV-1" }),
    })
    const res = await unreconcileTransaction("BT-2026-000001", { id: 7, name: "Alice" })
    expect(res).toMatchObject({ ok: true })
    const ledgerRelease = updates.find((u) => /UPDATE finance_records/i.test(u.sql))
    expect(ledgerRelease?.args).toContain("INV-1")
    expect(mocks.logFinanceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ action: "unreconcile" }) }),
    )
  })

  it("refuses to unreconcile a line that is not reconciled", async () => {
    setupDb({ txn: bankLine({ reconciliation_status: "Unreconciled" }) })
    const res = await unreconcileTransaction("BT-2026-000001")
    expect(res).toMatchObject({ ok: false, code: 409 })
  })
})
