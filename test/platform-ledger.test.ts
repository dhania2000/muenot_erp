import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec6 (#81-83, #240-241) — Platform seller ledger.
 *
 *   1. Pure double-entry builders: every journal (invoice, deferred invoice,
 *      credit-note reversal, payment, refund, credit grant, recognition) is
 *      BALANCED, and a credit note (negative invoice) reverses every leg.
 *   2. DB-backed postJournal: idempotent per (source_type, source_id, event),
 *      rejects unbalanced journals, and is strictly tenant-scoped so one
 *      tenant's platform books can never read or collide with another's.
 *
 * The ledger uses its OWN platform_journal tables — never the customer's
 * general_ledger — which the cross-tenant test implicitly asserts by keeping an
 * isolated in-memory store keyed by tenant_id.
 */

// ── In-memory DB + tenant context ───────────────────────────────────────────
const store = { journal: [] as any[], lines: [] as any[], seq: 0, entrySeq: 0 }
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

import {
  buildArToCreditJournal,
  buildCreditGrantJournal,
  buildInvoiceJournal,
  buildInvoiceReversalJournal,
  buildPaymentJournal,
  buildRecognitionJournal,
  buildRefundJournal,
  getPlatformTrialBalance,
  hasJournal,
  isBalanced,
  postJournal,
  totalCredit,
  totalDebit,
} from "@/lib/billing/platform-ledger"

beforeEach(() => {
  vi.clearAllMocks()
  store.journal = []
  store.lines = []
  store.seq = 0
  store.entrySeq = 0
  TENANT = 1

  mocks.currentTenantId.mockImplementation(() => TENANT)
  mocks.nextRecordId.mockImplementation(async () => `PJNL-${String(++store.entrySeq).padStart(6, "0")}`)

  mocks.query.mockImplementation(async (sql: string, params: any[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim()
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
      const [tenant_id, entry_no, source_type, source_id, event_type, entry_date, memo, total_debit, total_credit] =
        params
      const id = ++store.seq
      store.journal.push({
        id,
        tenant_id,
        entry_no,
        source_type,
        source_id,
        event_type,
        entry_date,
        memo,
        total_debit,
        total_credit,
      })
      return { insertId: id }
    }
    if (/^INSERT INTO platform_journal_lines/i.test(s)) {
      const [tenant_id, journal_id, account_code, account_name, debit, credit] = params
      store.lines.push({ tenant_id, journal_id, account_code, account_name, debit, credit })
      return {}
    }
    return []
  })

  mocks.tenantSelect.mockImplementation(async (table: string, opts: any = {}) => {
    if (table === "platform_journal_lines") {
      const map = new Map<string, any>()
      for (const l of store.lines.filter((x) => x.tenant_id === TENANT)) {
        const g = map.get(l.account_code) ?? {
          account_code: l.account_code,
          account_name: l.account_name,
          debit: 0,
          credit: 0,
        }
        g.debit += Number(l.debit)
        g.credit += Number(l.credit)
        map.set(l.account_code, g)
      }
      return [...map.values()].sort((a, b) => a.account_code.localeCompare(b.account_code))
    }
    if (table === "platform_journal") {
      let rows = store.journal.filter((r) => r.tenant_id === TENANT)
      if (opts.where && /source_type/.test(opts.where)) {
        const [source_type, source_id, ...events] = opts.params ?? []
        rows = rows.filter(
          (r) => r.source_type === source_type && r.source_id === String(source_id) && events.includes(r.event_type),
        )
      }
      return rows
    }
    return []
  })
})

// ── Pure builders ────────────────────────────────────────────────────────────
describe("journal builders are balanced", () => {
  it("invoice: Dr AR / Cr Revenue + GST", () => {
    const lines = buildInvoiceJournal({ total: 118, tax_total: 18 })
    expect(isBalanced(lines)).toBe(true)
    expect(totalDebit(lines)).toBe(118)
    const ar = lines.find((l) => l.account_code === "1100")
    const rev = lines.find((l) => l.account_code === "4000")
    const gst = lines.find((l) => l.account_code === "2200")
    expect(ar?.debit).toBe(118)
    expect(rev?.credit).toBe(100)
    expect(gst?.credit).toBe(18)
  })

  it("deferred invoice credits Deferred Revenue instead of Revenue", () => {
    const lines = buildInvoiceJournal({ total: 118, tax_total: 18 }, { deferred: true })
    expect(isBalanced(lines)).toBe(true)
    expect(lines.find((l) => l.account_code === "2300")?.credit).toBe(100)
    expect(lines.find((l) => l.account_code === "4000")).toBeUndefined()
  })

  it("credit note (negative invoice) reverses every leg and stays balanced", () => {
    const lines = buildInvoiceJournal({ total: -118, tax_total: -18 })
    expect(isBalanced(lines)).toBe(true)
    expect(lines.find((l) => l.account_code === "1100")?.credit).toBe(118) // AR now credited
    expect(lines.find((l) => l.account_code === "4000")?.debit).toBe(100) // revenue reversed
  })

  it("invoice applying account credit still balances", () => {
    const lines = buildInvoiceJournal({ total: 118, tax_total: 18, credit_applied: 50 })
    expect(isBalanced(lines)).toBe(true)
  })

  it("reversal takes unrecognized net from Deferred first, remainder from Revenue", () => {
    const lines = buildInvoiceReversalJournal({ gross: 118, tax: 18, fromDeferred: 60, creditApplied: 0 })
    expect(isBalanced(lines)).toBe(true)
    expect(lines.find((l) => l.account_code === "2300")?.debit).toBe(60)
    expect(lines.find((l) => l.account_code === "4000")?.debit).toBe(40)
    expect(lines.find((l) => l.account_code === "1100")?.credit).toBe(118)
  })

  it("payment, refund, credit grant and recognition all balance", () => {
    expect(isBalanced(buildPaymentJournal(100))).toBe(true)
    expect(isBalanced(buildRefundJournal(100))).toBe(true)
    expect(isBalanced(buildRefundJournal(100, { asCredit: true, arSettled: 40 }))).toBe(true)
    expect(isBalanced(buildCreditGrantJournal(25))).toBe(true)
    expect(isBalanced(buildArToCreditJournal(25))).toBe(true)
    const rec = buildRecognitionJournal(10)
    expect(isBalanced(rec)).toBe(true)
    expect(rec.find((l) => l.account_code === "2300")?.debit).toBe(10)
    expect(rec.find((l) => l.account_code === "4000")?.credit).toBe(10)
  })

  it("totalDebit/totalCredit agree for a balanced set", () => {
    const lines = buildInvoiceJournal({ total: 236, tax_total: 36 })
    expect(totalDebit(lines)).toBe(totalCredit(lines))
  })
})

// ── DB-backed postJournal ─────────────────────────────────────────────────────
describe("postJournal (idempotent, tenant-scoped, fail-closed)", () => {
  const invoice = () => ({
    sourceType: "invoice" as const,
    sourceId: 42,
    eventType: "invoice_finalized",
    entryDate: "2026-09-01",
    lines: buildInvoiceJournal({ total: 118, tax_total: 18 }),
  })

  it("posts once and is a no-op on replay (same source/event)", async () => {
    const first = await postJournal(invoice())
    expect(first.posted).toBe(true)
    const second = await postJournal(invoice())
    expect(second.posted).toBe(false)
    expect(second.journalId).toBe(first.journalId)
    expect(store.journal).toHaveLength(1)
    expect(store.lines.filter((l) => l.journal_id === first.journalId)).toHaveLength(3)
  })

  it("refuses to post an unbalanced journal", async () => {
    await expect(
      postJournal({
        sourceType: "invoice",
        sourceId: 99,
        eventType: "bad",
        entryDate: "2026-09-01",
        lines: [
          { account_code: "1100", account_name: "AR", debit: 100, credit: 0 },
          { account_code: "4000", account_name: "Rev", debit: 0, credit: 90 },
        ],
      }),
    ).rejects.toThrow(/unbalanced/i)
    expect(store.journal).toHaveLength(0)
  })

  it("drops zero-only lines and no-ops when nothing remains", async () => {
    const res = await postJournal({
      sourceType: "payment",
      sourceId: 1,
      eventType: "noop",
      entryDate: "2026-09-01",
      lines: [{ account_code: "1000", account_name: "Cash", debit: 0, credit: 0 }],
    })
    expect(res.posted).toBe(false)
    expect(store.journal).toHaveLength(0)
  })

  it("keeps each tenant's platform books isolated (same source id, different tenant)", async () => {
    TENANT = 1
    await postJournal(invoice())
    TENANT = 2
    const t2 = await postJournal(invoice())
    expect(t2.posted).toBe(true) // not blocked by tenant 1's identical source
    expect(store.journal).toHaveLength(2)

    // Tenant 2 sees only its own journal; tenant 1's is invisible to it.
    expect(await hasJournal("invoice", 42, ["invoice_finalized"])).toBe(true)
    TENANT = 3
    expect(await hasJournal("invoice", 42, ["invoice_finalized"])).toBe(false)
  })

  it("trial balance is balanced and scoped to the current tenant", async () => {
    TENANT = 1
    await postJournal(invoice())
    await postJournal({
      sourceType: "payment",
      sourceId: 42,
      eventType: "payment_received",
      entryDate: "2026-09-02",
      lines: buildPaymentJournal(118),
    })
    const tb1 = await getPlatformTrialBalance()
    expect(tb1.balanced).toBe(true)
    expect(tb1.totalDebit).toBe(tb1.totalCredit)
    // AR net = 118 (invoice) - 118 (payment) = 0
    expect(tb1.accounts.find((a) => a.account_code === "1100")?.balance).toBe(0)

    TENANT = 9
    const tb9 = await getPlatformTrialBalance()
    expect(tb9.accounts).toHaveLength(0)
  })
})
