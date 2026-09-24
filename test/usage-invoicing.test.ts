import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec 5 — usage-based billing RECONCILIATION service (DB-backed orchestration).
 *
 * The pure overage/line math is covered in usage-billing.test.ts. Here we drive
 * the composed service (lib/billing/usage-invoicing.ts) against an in-memory
 * stand-in for the database, subscription view and invoice creator to prove the
 * end-to-end idempotency contract the spec cares about:
 *   - a first run bills the full overage as one line per metric,
 *   - a duplicate run with no new usage creates NO invoice,
 *   - late events bill only the incremental overage (no double charging),
 *   - a mid-cycle upgrade that raises the allowance stops further charges,
 *   - a zero-usage period produces no invoice.
 */

const store = vi.hoisted(() => ({
  allowances: [] as Array<{
    meter_key: string
    allowance: number
    overage_rate: number
    currency: string
    is_active: number
  }>,
  ledger: new Map<string, { meter_key: string; billed_units: number; billed_amount: number; invoice_id: number }>(),
  usage: new Map<string, number>(),
  invoices: [] as Array<{ id: number; lines: any[]; total: number }>,
  nextInvoiceId: 1,
  sub: {
    id: 1,
    current_period_start: "2026-01-01",
    current_period_end: "2026-02-01",
    currency: "USD",
    plan_name: "Pro",
    customer_name: "Acme Inc",
    status: "active",
  } as any,
}))

vi.mock("@/lib/db", () => ({
  query: vi.fn(async (sql: string, params: any[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim()
    if (s.startsWith("CREATE TABLE")) return []
    if (s.includes("FROM usage_allowances")) return store.allowances
    if (s.includes("FROM usage_billing_ledger")) {
      return [...store.ledger.values()].map((r) => ({ meter_key: r.meter_key, billed_units: r.billed_units }))
    }
    if (s.includes("INSERT INTO usage_billing_ledger")) {
      const [, , , , meterKey, units, amount, invId] = params
      const ex = store.ledger.get(meterKey)
      if (ex) {
        ex.billed_units += Number(units)
        ex.billed_amount += Number(amount)
        ex.invoice_id = invId
      } else {
        store.ledger.set(meterKey, {
          meter_key: meterKey,
          billed_units: Number(units),
          billed_amount: Number(amount),
          invoice_id: invId,
        })
      }
      return { affectedRows: 1 }
    }
    return []
  }),
}))

vi.mock("@/lib/tenant-scope", () => ({ currentTenantId: () => 1 }))

vi.mock("@/lib/billing/usage-metering", () => ({
  METER_CATALOG: [],
  isMeterKey: () => true,
  getMeter: (key: string) => ({ key, label: key, unit: "units", kind: "counter" }),
  getPeriodUsage: vi.fn(async () => store.usage),
}))

vi.mock("@/lib/billing/subscription-engine", () => ({
  getSubscriptionView: vi.fn(async () => store.sub),
}))

vi.mock("@/lib/billing/billing-engine", () => ({
  createInvoice: vi.fn(async (input: any) => {
    const inv = { id: store.nextInvoiceId++, lines: input.lines, total: 0 }
    store.invoices.push(inv)
    return { id: inv.id }
  }),
}))

import { reconcileSubscriptionUsage } from "@/lib/billing/usage-invoicing"
import { createInvoice } from "@/lib/billing/billing-engine"

const session = { userId: 7, tenantId: 1 } as any

function seedAllowance(meter_key: string, allowance: number, overage_rate: number, is_active = 1) {
  store.allowances.push({ meter_key, allowance, overage_rate, currency: "USD", is_active })
}

beforeEach(() => {
  store.allowances = []
  store.ledger = new Map()
  store.usage = new Map()
  store.invoices = []
  store.nextInvoiceId = 1
  store.sub = {
    id: 1,
    current_period_start: "2026-01-01",
    current_period_end: "2026-02-01",
    currency: "USD",
    plan_name: "Pro",
    customer_name: "Acme Inc",
    status: "active",
  }
  vi.clearAllMocks()
})

describe("reconcileSubscriptionUsage — first run", () => {
  it("bills the full overage as one line per metric", async () => {
    seedAllowance("api_calls", 1000, 0.01)
    store.usage.set("api_calls", 1500)

    const r = await reconcileSubscriptionUsage(1, session)

    expect(r.noop).toBe(false)
    expect(r.invoiceId).toBe(1)
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]).toMatchObject({ meterKey: "api_calls", quantity: 500, amount: 5 })
    expect(r.total).toBe(5)
    // Ledger records the cumulative overage billed.
    expect(store.ledger.get("api_calls")?.billed_units).toBe(500)
  })

  it("emits one line per configured metric", async () => {
    seedAllowance("api_calls", 1000, 0.01)
    seedAllowance("sms", 100, 0.05)
    store.usage.set("api_calls", 1200) // 200 over -> $2
    store.usage.set("sms", 150) // 50 over -> $2.50

    const r = await reconcileSubscriptionUsage(1, session)
    expect(r.lines).toHaveLength(2)
    expect(r.total).toBeCloseTo(4.5)
  })

  it("charges nothing when usage is within the allowance", async () => {
    seedAllowance("api_calls", 1000, 0.01)
    store.usage.set("api_calls", 900)

    const r = await reconcileSubscriptionUsage(1, session)
    expect(r.noop).toBe(true)
    expect(r.invoiceId).toBeNull()
    expect(createInvoice).not.toHaveBeenCalled()
  })
})

describe("reconcileSubscriptionUsage — duplicate run (idempotency)", () => {
  it("does not create a second invoice when nothing changed", async () => {
    seedAllowance("api_calls", 1000, 0.01)
    store.usage.set("api_calls", 1500)

    const first = await reconcileSubscriptionUsage(1, session)
    expect(first.noop).toBe(false)

    const second = await reconcileSubscriptionUsage(1, session)
    expect(second.noop).toBe(true)
    expect(second.invoiceId).toBeNull()
    expect(store.invoices).toHaveLength(1)
    // Ledger unchanged — no double charge.
    expect(store.ledger.get("api_calls")?.billed_units).toBe(500)
  })
})

describe("reconcileSubscriptionUsage — late events", () => {
  it("bills only the incremental overage on a re-run", async () => {
    seedAllowance("api_calls", 1000, 0.01)
    store.usage.set("api_calls", 1500)
    await reconcileSubscriptionUsage(1, session) // bills 500 units / $5

    // Late events land: cumulative usage now 1800.
    store.usage.set("api_calls", 1800)
    const r = await reconcileSubscriptionUsage(1, session)

    expect(r.noop).toBe(false)
    expect(r.lines[0]).toMatchObject({ meterKey: "api_calls", quantity: 300, amount: 3 })
    // Cumulative billed overage is now 800 units.
    expect(store.ledger.get("api_calls")?.billed_units).toBe(800)
    expect(store.invoices).toHaveLength(2)
  })
})

describe("reconcileSubscriptionUsage — mid-cycle upgrade", () => {
  it("stops charging once a larger allowance covers the usage", async () => {
    seedAllowance("api_calls", 1000, 0.01)
    store.usage.set("api_calls", 1500)
    await reconcileSubscriptionUsage(1, session) // bills 500 units

    // Upgrade raises the allowance above current usage; no refund, no new charge.
    store.allowances[0].allowance = 2000
    const r = await reconcileSubscriptionUsage(1, session)

    expect(r.noop).toBe(true)
    expect(r.invoiceId).toBeNull()
    // Prior charge stands; nothing added.
    expect(store.ledger.get("api_calls")?.billed_units).toBe(500)
  })

  it("bills only the remaining overage when an upgrade partially covers usage", async () => {
    seedAllowance("api_calls", 1000, 0.01)
    store.usage.set("api_calls", 1500)
    await reconcileSubscriptionUsage(1, session) // billed 500 units

    // Later: allowance raised to 1200, usage grew to 1600 -> cumulative overage 400.
    store.allowances[0].allowance = 1200
    store.usage.set("api_calls", 1600)
    const r = await reconcileSubscriptionUsage(1, session)

    // Already billed 500 > new cumulative overage 400 -> no negative line, no-op.
    expect(r.noop).toBe(true)
    expect(store.ledger.get("api_calls")?.billed_units).toBe(500)
  })
})

describe("reconcileSubscriptionUsage — zero usage", () => {
  it("produces no invoice for a zero-usage period", async () => {
    seedAllowance("api_calls", 1000, 0.01)
    // no usage recorded
    const r = await reconcileSubscriptionUsage(1, session)
    expect(r.noop).toBe(true)
    expect(r.invoiceId).toBeNull()
    expect(createInvoice).not.toHaveBeenCalled()
  })
})

describe("reconcileSubscriptionUsage — inactive allowance", () => {
  it("ignores meters whose allowance is inactive", async () => {
    seedAllowance("api_calls", 1000, 0.01, 0) // inactive
    store.usage.set("api_calls", 5000)
    const r = await reconcileSubscriptionUsage(1, session)
    expect(r.noop).toBe(true)
  })

  it("ignores meters with a zero overage rate (included, not billable)", async () => {
    seedAllowance("api_calls", 1000, 0)
    store.usage.set("api_calls", 5000)
    const r = await reconcileSubscriptionUsage(1, session)
    expect(r.noop).toBe(true)
  })
})
