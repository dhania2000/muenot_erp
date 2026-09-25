import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec62 (#242-244) — SaaS seller invoices post to the PLATFORM books only.
 *
 * Drives the real saas-accounting orchestration (postInvoiceAccounting /
 * postPaymentAccounting / postRefundAccounting) through the real postJournal
 * over an in-memory DB, and asserts:
 *   1. Every write lands in platform_journal / platform_journal_lines — NEVER in
 *      a customer finance table (general_ledger / journal_entries).
 *   2. Posting is idempotent per (source, event): a replay is a no-op.
 *   3. Each tenant's platform books are isolated: the same seller invoice id in
 *      two tenants produces two independent journals.
 *
 * revenue-recognition / revenue-schedule are mocked out — this suite is about
 * the boundary, and the non-deferred path never touches them anyway.
 */

const store = { journal: [] as any[], lines: [] as any[], seq: 0, entrySeq: 0 }
const sqlLog: string[] = []
let TENANT = 1

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  currentTenantId: vi.fn(),
  tenantSelect: vi.fn(),
  nextRecordId: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: mocks.query }))
vi.mock("@/lib/record-ids", () => ({ nextRecordId: mocks.nextRecordId }))
vi.mock("@/lib/tenant-scope", () => ({
  currentTenantId: mocks.currentTenantId,
  tenantSelect: mocks.tenantSelect,
}))
// Keep the deferred-revenue subsystem out of the boundary test.
vi.mock("@/lib/billing/revenue-recognition", () => ({
  createSchedule: vi.fn(async () => {}),
  reverseDeferredRevenue: vi.fn(async () => ({ fromDeferred: 0 })),
}))

import {
  postInvoiceAccounting,
  postPaymentAccounting,
  postRefundAccounting,
} from "@/lib/billing/saas-accounting"

beforeEach(() => {
  vi.clearAllMocks()
  store.journal = []
  store.lines = []
  store.seq = 0
  store.entrySeq = 0
  sqlLog.length = 0
  TENANT = 1

  mocks.currentTenantId.mockImplementation(() => TENANT)
  mocks.nextRecordId.mockImplementation(async () => `PJNL-${String(++store.entrySeq).padStart(6, "0")}`)

  mocks.query.mockImplementation(async (sql: string, params: any[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim()
    sqlLog.push(s)
    if (/^CREATE TABLE/i.test(s)) return []
    if (/^SELECT id, entry_no FROM platform_journal/i.test(s)) {
      const [tenant_id, source_type, source_id, event_type] = params
      const hit = store.journal.find(
        (r) =>
          r.tenant_id === tenant_id &&
          r.source_type === source_type &&
          r.source_id === source_id &&
          r.event_type === event_type,
      )
      return hit ? [{ id: hit.id, entry_no: hit.entry_no }] : []
    }
    if (/^INSERT INTO platform_journal /i.test(s)) {
      const [tenant_id, entry_no, source_type, source_id, event_type] = params
      const id = ++store.seq
      store.journal.push({ id, tenant_id, entry_no, source_type, source_id, event_type })
      return { insertId: id }
    }
    if (/^INSERT INTO platform_journal_lines/i.test(s)) {
      const [tenant_id, journal_id, account_code, account_name, debit, credit] = params
      store.lines.push({ tenant_id, journal_id, account_code, account_name, debit, credit })
      return {}
    }
    return []
  })
})

const invoice = (over: Record<string, unknown> = {}) => ({
  id: 42,
  invoice_no: "SINV-42",
  status: "open",
  issue_date: "2026-09-01",
  total: 118,
  tax_total: 18,
  currency: "INR",
  ...over,
})

/** No SQL statement ever names a customer finance table. */
function assertNoCustomerFinanceWrites() {
  const offenders = sqlLog.filter((s) => /\b(general_ledger|journal_entries|journal_entry_lines)\b/i.test(s))
  expect(offenders).toEqual([])
}

describe("seller invoice posts to platform books only", () => {
  it("writes platform_journal + lines and no customer finance", async () => {
    await postInvoiceAccounting(invoice())
    expect(store.journal).toHaveLength(1)
    expect(store.journal[0].source_type).toBe("invoice")
    expect(store.lines.length).toBeGreaterThan(0)
    // Every write targeted a platform ledger table.
    expect(sqlLog.some((s) => /INSERT INTO platform_journal /i.test(s))).toBe(true)
    assertNoCustomerFinanceWrites()
  })

  it("a draft invoice posts nothing at all", async () => {
    await postInvoiceAccounting(invoice({ status: "draft" }))
    expect(store.journal).toHaveLength(0)
    assertNoCustomerFinanceWrites()
  })

  it("invoice + payment + refund all stay on the platform ledger", async () => {
    await postInvoiceAccounting(invoice())
    await postPaymentAccounting({ id: 42, invoice_no: "SINV-42", amount: 118, paid_at: "2026-09-02" } as any)
    await postRefundAccounting({ id: 42, invoice_no: "SINV-42", amount: 50, refunded_at: "2026-09-03" } as any)
    expect(store.journal.length).toBeGreaterThanOrEqual(3)
    assertNoCustomerFinanceWrites()
  })
})

describe("idempotency and tenant isolation", () => {
  it("re-posting the same invoice is a no-op", async () => {
    await postInvoiceAccounting(invoice())
    await postInvoiceAccounting(invoice())
    expect(store.journal).toHaveLength(1)
  })

  it("keeps each tenant's platform books separate for the same invoice id", async () => {
    TENANT = 1
    await postInvoiceAccounting(invoice())
    TENANT = 2
    await postInvoiceAccounting(invoice())
    expect(store.journal).toHaveLength(2)
    expect(store.journal.map((j) => j.tenant_id).sort()).toEqual([1, 2])
    assertNoCustomerFinanceWrites()
  })
})
