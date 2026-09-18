import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GatewayEvent } from "@/lib/billing/gateways/types"

/**
 * SPEC 22 — Phase 4: duplicate / out-of-order / retry validation of the webhook
 * processing ledger. The DB, tenant-scope helpers and billing engine are mocked
 * with an in-memory store so we exercise the pure idempotency + retry logic:
 *
 *   - an event is applied exactly once (redelivery → "duplicate"),
 *   - a late/out-of-order event never clobbers a settled payment,
 *   - a failed event is reclaimed and retried on redelivery (attempts++),
 *   - a stored failed event can be replayed manually,
 *   - events without a tenant / of unknown type are ignored, not applied.
 */

// ── In-memory store ──────────────────────────────────────────────────────────

type EventRow = Record<string, any>
const store = {
  events: new Map<string, EventRow>(),
  payments: [] as any[],
  seq: 1,
}

function resetStore() {
  store.events.clear()
  store.payments = []
  store.seq = 1
}

const nowIso = () => new Date().toISOString()

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  query: vi.fn(async () => []),
  // Report every column as present so no ALTER path runs under test.
  tableColumns: vi.fn(
    async () =>
      new Set([
        "id",
        "tenant_id",
        "gateway",
        "event_id",
        "event_type",
        "status",
        "effect",
        "attempts",
        "signature_ok",
        "invoice_id",
        "payment_id",
        "last_error",
        "reason",
        "raw",
        "normalized",
        "received_at",
        "updated_at",
        "created_at",
      ]),
  ),
}))

vi.mock("@/lib/tenant-scope", () => ({
  runForTenant: (_ctx: any, fn: () => any) => fn(),
  tenantSelect: async (table: string, opts: any = {}) => {
    if (table === "billing_gateway_events") {
      if (typeof opts.columns === "string" && opts.columns.includes("COUNT(*)")) {
        const groups: Record<string, any> = {}
        for (const row of store.events.values()) {
          const g = (groups[row.status] ||= { status: row.status, n: 0, retried: 0 })
          g.n++
          if (row.attempts > 1) g.retried++
        }
        return Object.values(groups)
      }
      if (opts.where && opts.where.includes("event_id")) {
        const [gateway, eventId] = opts.params
        const row = store.events.get(`${gateway}:${eventId}`)
        return row ? [row] : []
      }
      let rows = [...store.events.values()]
      if (opts.where && opts.where.includes("status")) rows = rows.filter((r) => r.status === opts.params[0])
      return rows.sort((a, b) => b.id - a.id)
    }
    if (table === "billing_payments") {
      const where: string = opts.where || ""
      if (where.includes("reference IN")) {
        const invoiceId = opts.params[0]
        const refs = opts.params.slice(1)
        const row = store.payments.find((p) => p.invoice_id === invoiceId && refs.includes(p.reference))
        return row ? [row] : []
      }
      if (where.includes("status = 'pending'")) {
        const [invoiceId, gateway] = opts.params
        const row = store.payments.find((p) => p.invoice_id === invoiceId && p.status === "pending" && p.gateway === gateway)
        return row ? [row] : []
      }
      return []
    }
    return []
  },
  tenantInsert: async (table: string, data: any) => {
    if (table === "billing_gateway_events") {
      const key = `${data.gateway}:${data.event_id}`
      if (store.events.has(key)) throw new Error("ER_DUP_ENTRY: Duplicate entry")
      const id = store.seq++
      store.events.set(key, {
        id,
        gateway: data.gateway,
        event_id: data.event_id,
        event_type: data.event_type,
        status: data.status,
        effect: null,
        attempts: data.attempts ?? 1,
        signature_ok: data.signature_ok ?? 1,
        invoice_id: null,
        payment_id: null,
        last_error: null,
        reason: null,
        raw: data.raw ?? null,
        normalized: data.normalized ?? null,
        received_at: nowIso(),
        updated_at: nowIso(),
        created_at: nowIso(),
      })
      return { insertId: id, affectedRows: 1 }
    }
    return { insertId: 0, affectedRows: 1 }
  },
  tenantUpdate: async (table: string, patch: any, _where: string, params: any[]) => {
    if (table === "billing_gateway_events") {
      const [gateway, eventId] = params
      const row = store.events.get(`${gateway}:${eventId}`)
      if (row) Object.assign(row, patch)
      return row ? 1 : 0
    }
    if (table === "billing_payments") {
      const id = Number(params[params.length - 1])
      const p = store.payments.find((x) => x.id === id)
      if (p) Object.assign(p, patch)
      return p ? 1 : 0
    }
    return 0
  },
  tenantFindById: async (table: string, id: number) => {
    if (table === "billing_gateway_events") {
      for (const row of store.events.values()) if (row.id === Number(id)) return row
    }
    return null
  },
}))

const getInvoice = vi.fn(async (id: number) => ({ id, invoice_no: `INV-${id}` }))
const recordPayment = vi.fn(async (_invoiceId: number, data: any) => {
  const id = 900 + store.payments.length
  store.payments.push({ id, invoice_id: _invoiceId, status: data.status, gateway: data.gateway, reference: data.reference })
  return { id }
})
const refundInvoice = vi.fn(async () => ({ id: 555 }))
const ingestReconciliation = vi.fn(async () => ({ id: 1 }))
const recomputeInvoice = vi.fn(async () => undefined)

vi.mock("@/lib/billing/billing-engine", () => ({
  getInvoice: (...a: any[]) => (getInvoice as any)(...a),
  recordPayment: (...a: any[]) => (recordPayment as any)(...a),
  refundInvoice: (...a: any[]) => (refundInvoice as any)(...a),
  ingestReconciliation: (...a: any[]) => (ingestReconciliation as any)(...a),
  recomputeInvoice: (...a: any[]) => (recomputeInvoice as any)(...a),
}))

import { applyGatewayEvent, listWebhookEvents, getWebhookEventStats, replayWebhookEvent } from "@/lib/billing/gateways/webhook-service"

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeEvent(over: Partial<GatewayEvent> = {}): GatewayEvent {
  return {
    id: "evt_1",
    gateway: "stripe",
    type: "payment.succeeded",
    providerPaymentId: "pi_1",
    providerOrderId: null,
    providerRefundId: null,
    reference: "BPAY-1",
    metadata: { tenant_id: "7", invoice_id: "100" },
    amount: 25,
    currency: "USD",
    status: "succeeded",
    occurredAt: null,
    raw: { id: "evt_1" },
    ...over,
  }
}

function seedPendingPayment(reference: string, id = 1) {
  store.payments.push({ id, invoice_id: 100, status: "pending", gateway: "stripe", reference })
}

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
  getInvoice.mockImplementation(async (id: number) => ({ id, invoice_no: `INV-${id}` }))
  recomputeInvoice.mockImplementation(async () => undefined)
})

afterEach(() => vi.clearAllMocks())

// ── Idempotency / duplicates ────────────────────────────────────────────────

describe("idempotency", () => {
  it("applies an event once and treats redelivery as a duplicate", async () => {
    seedPendingPayment("pi_1")
    const ev = makeEvent()

    const first = await applyGatewayEvent(ev)
    expect(first.status).toBe("processed")
    expect(first.effect).toBe("payment_settled")
    expect(first.paymentId).toBe(1)
    expect(store.payments[0].status).toBe("succeeded")

    const second = await applyGatewayEvent(ev)
    expect(second.status).toBe("duplicate")
    // No second settlement happened.
    expect(recomputeInvoice).toHaveBeenCalledTimes(1)
    const stats = await getWebhookEventStats()
    expect(stats.total).toBe(1)
    expect(stats.processed).toBe(1)
  })

  it("records a fresh payment when no opened charge exists", async () => {
    const ev = makeEvent({ id: "evt_fresh", providerPaymentId: "pi_x", reference: "no-match" })
    const res = await applyGatewayEvent(ev)
    expect(res.status).toBe("processed")
    expect(res.effect).toBe("payment_recorded")
    expect(recordPayment).toHaveBeenCalledTimes(1)
  })
})

// ── Out-of-order ─────────────────────────────────────────────────────────────

describe("out-of-order delivery", () => {
  it("a late payment.failed never clobbers an already-settled payment", async () => {
    seedPendingPayment("pi_1")
    await applyGatewayEvent(makeEvent()) // settles payment 1
    expect(store.payments[0].status).toBe("succeeded")

    const late = await applyGatewayEvent(
      makeEvent({ id: "evt_late_fail", type: "payment.failed", status: "failed" }),
    )
    expect(late.status).toBe("processed")
    expect(late.effect).toBe("none")
    // Payment stays settled.
    expect(store.payments[0].status).toBe("succeeded")
  })

  it("marks a pending payment failed when the failure arrives first", async () => {
    seedPendingPayment("pi_1")
    const res = await applyGatewayEvent(makeEvent({ id: "evt_fail", type: "payment.failed", status: "failed" }))
    expect(res.status).toBe("processed")
    expect(res.effect).toBe("payment_failed")
    expect(store.payments[0].status).toBe("failed")
  })
})

// ── Retry handling ────────────────────────────────────────────────────────────

describe("retry handling", () => {
  it("reclaims and retries a failed event on redelivery, bumping attempts", async () => {
    seedPendingPayment("pi_1")
    const ev = makeEvent()

    // First delivery: processing throws before any mutation.
    getInvoice.mockRejectedValueOnce(new Error("db timeout"))
    await expect(applyGatewayEvent(ev)).rejects.toThrow("db timeout")

    let rows = await listWebhookEvents({})
    expect(rows[0].status).toBe("failed")
    expect(rows[0].attempts).toBe(1)
    expect(rows[0].last_error).toContain("db timeout")
    expect(store.payments[0].status).toBe("pending") // untouched

    // Redelivery: reclaimed and retried successfully.
    const retry = await applyGatewayEvent(ev)
    expect(retry.status).toBe("processed")
    expect(retry.effect).toBe("payment_settled")
    expect(retry.attempts).toBe(2)

    rows = await listWebhookEvents({})
    expect(rows[0].status).toBe("processed")
    expect(rows[0].attempts).toBe(2)
    expect(rows[0].last_error).toBeNull()

    const stats = await getWebhookEventStats()
    expect(stats.failed).toBe(0)
    expect(stats.processed).toBe(1)
    expect(stats.retried).toBe(1)
  })

  it("does not retry an in-flight (fresh processing) event as a duplicate reclaim", async () => {
    seedPendingPayment("pi_1")
    const ev = makeEvent()
    // Manually plant a fresh in-flight row (not stale).
    store.events.set("stripe:evt_1", {
      id: 1,
      gateway: "stripe",
      event_id: "evt_1",
      event_type: "payment.succeeded",
      status: "processing",
      attempts: 1,
      signature_ok: 1,
      updated_at: nowIso(),
      created_at: nowIso(),
      received_at: nowIso(),
      normalized: JSON.stringify(ev),
    })
    store.seq = 2
    const res = await applyGatewayEvent(ev)
    expect(res.status).toBe("duplicate")
    // The concurrent delivery did not settle the payment.
    expect(store.payments[0].status).toBe("pending")
  })
})

// ── Manual replay ────────────────────────────────────────────────────────────

describe("manual replay", () => {
  it("replays a stored failed event to completion", async () => {
    seedPendingPayment("pi_1")
    const ev = makeEvent()
    getInvoice.mockRejectedValueOnce(new Error("transient"))
    await expect(applyGatewayEvent(ev)).rejects.toThrow("transient")

    const row = (await listWebhookEvents({}))[0]
    expect(row.status).toBe("failed")

    const result = await replayWebhookEvent(row.id)
    expect(result.status).toBe("processed")
    expect(result.effect).toBe("payment_settled")
    expect(result.attempts).toBe(2)
    expect(store.payments[0].status).toBe("succeeded")
  })

  it("rejects replay of an unknown event id", async () => {
    await expect(replayWebhookEvent(9999)).rejects.toThrow(/not found/i)
  })
})

// ── Ignored events ────────────────────────────────────────────────────────────

describe("ignored events", () => {
  it("ignores an event without a tenant id and stores nothing", async () => {
    const res = await applyGatewayEvent(makeEvent({ metadata: {} }))
    expect(res.status).toBe("ignored")
    expect(store.events.size).toBe(0)
  })

  it("ignores an unknown event type but still records it", async () => {
    const res = await applyGatewayEvent(makeEvent({ id: "evt_unknown", type: "unknown" }))
    expect(res.status).toBe("ignored")
    const rows = await listWebhookEvents({})
    expect(rows[0].status).toBe("ignored")
    // Redelivery of an ignored (terminal) event is a duplicate.
    const again = await applyGatewayEvent(makeEvent({ id: "evt_unknown", type: "unknown" }))
    expect(again.status).toBe("duplicate")
  })
})
