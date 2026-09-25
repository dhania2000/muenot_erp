import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec23 — invoice checkout: auth, tenant scope, validation, idempotency,
 * cross-tenant isolation, gateway failure and audit. The tenant-scope layer
 * is replaced by an in-memory, tenant-partitioned store so the tests exercise
 * the real route + service logic without a database.
 */

type Row = Record<string, any>
const state = vi.hoisted(() => ({
  tenant: null as number | null,
  payments: [] as Row[],
  invoices: new Map<string, Row>(),
  seq: 0,
  session: null as Row | null,
  audit: [] as Row[],
  createPayment: null as any,
}))

vi.mock("@/lib/tenant-scope", () => {
  const scoped = () => {
    if (state.tenant == null) throw new Error("no tenant in scope")
    return state.payments.filter((p) => p.tenant_id === state.tenant)
  }
  return {
    runForTenant: async (ctx: { tenantId: number }, fn: () => Promise<unknown>) => {
      const prev = state.tenant
      state.tenant = ctx.tenantId
      try {
        return await fn()
      } finally {
        state.tenant = prev
      }
    },
    currentTenantId: () => {
      if (state.tenant == null) throw new Error("no tenant in scope")
      return state.tenant
    },
    tenantSelect: async (_t: string, opts: { params: any[] }) => scoped().filter((p) => p.checkout_key === opts.params[0]).slice(0, 1),
    tenantUpdate: async (_t: string, set: Row, _w: string, params: any[]) => {
      const row = scoped().find((p) => p.id === params[0])
      if (!row) return 0
      Object.assign(row, set)
      return 1
    },
    tenantInsert: async (_t: string, values: Row) => {
      const clash = scoped().some((p) => values.checkout_key != null && p.checkout_key === values.checkout_key)
      if (clash) throw Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" })
      const row = { id: ++state.seq, tenant_id: state.tenant, ...values }
      state.payments.push(row)
      return { insertId: row.id, affectedRows: 1 }
    },
  }
})

vi.mock("@/lib/billing/billing-engine", async () => {
  class BillingError extends Error {
    status: number
    constructor(message: string, status = 400) {
      super(message)
      this.status = status
    }
  }
  return {
    BillingError,
    getInvoice: async (id: number) => state.invoices.get(`${state.tenant}:${id}`) ?? null,
  }
})

vi.mock("@/lib/billing/gateways/registry", () => ({
  configureGatewaysFromEnv: () => ["stripe"],
  hasGateway: (name: string) => name === "stripe",
  listGateways: () => ["stripe"],
  getGateway: () => ({ createPayment: (...args: any[]) => state.createPayment(...args) }),
}))

vi.mock("@/lib/record-ids", () => ({ nextRecordId: async () => `BPAY-${String(++state.seq).padStart(5, "0")}` }))
vi.mock("@/lib/auth", () => ({ getSession: async () => state.session }))
vi.mock("@/lib/audit-log-store", () => ({
  recordAuditLogFromRequest: async (_req: Request, input: Row) => {
    state.audit.push(input)
  },
}))

const { POST } = await import("@/app/api/billing/invoices/[id]/checkout/route")
const { checkoutKey, normalizeProvider } = await import("@/lib/billing/checkout")

function invoice(tenantId: number, id: number, over: Row = {}) {
  state.invoices.set(`${tenantId}:${id}`, {
    id,
    invoice_no: `INV-${id}`,
    status: "open",
    currency: "USD",
    total: 100,
    credit_applied: 0,
    amount_paid: 0,
    ...over,
  })
}

function call(id: string, body: unknown = { provider: "stripe" }) {
  const req = new Request(`http://t/api/billing/invoices/${id}/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  return POST(req as any, { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  state.tenant = null
  state.payments = []
  state.invoices = new Map()
  state.seq = 0
  state.audit = []
  state.session = { userId: 7, role: "admin", tenantId: 1 }
  let n = 0
  state.createPayment = vi.fn(async () => ({ providerId: `pi_${++n}`, clientParams: { clientSecret: `secret_${n}` } }))
  invoice(1, 10)
})

describe("checkout auth and validation", () => {
  it("rejects anonymous callers with 401", async () => {
    state.session = null
    expect((await call("10")).status).toBe(401)
  })

  it("rejects non-admin members with 403 and never touches the gateway", async () => {
    state.session = { userId: 8, role: "employee", tenantId: 1 }
    expect((await call("10")).status).toBe(403)
    expect(state.createPayment).not.toHaveBeenCalled()
  })

  it("rejects a session without a tenant", async () => {
    state.session = { userId: 7, role: "admin" }
    expect((await call("10")).status).toBe(403)
  })

  it.each(["0", "-1", "abc", "1.5"])("rejects invalid invoice id %s", async (id) => {
    expect((await call(id)).status).toBe(400)
  })

  it("rejects missing, malformed and unknown providers", async () => {
    expect((await call("10", {})).status).toBe(400)
    expect((await call("10", { provider: "../etc" })).status).toBe(400)
    expect((await call("10", { provider: "paypal" })).status).toBe(400)
    expect((await call("10", "not json")).status).toBe(400)
    expect(() => normalizeProvider("  STRIPE ")).not.toThrow()
  })

  it("refuses void and fully paid invoices", async () => {
    invoice(1, 11, { status: "void" })
    invoice(1, 12, { amount_paid: 100 })
    expect((await call("11")).status).toBe(409)
    expect((await call("12")).status).toBe(409)
  })
})

describe("checkout idempotency", () => {
  it("creates one pending payment and replays it on retry", async () => {
    const first = await call("10")
    expect(first.status).toBe(201)
    const a = await first.json()
    const second = await call("10")
    expect(second.status).toBe(200)
    const b = await second.json()

    expect(b.replayed).toBe(true)
    expect(b.paymentNo).toBe(a.paymentNo)
    expect(state.payments).toHaveLength(1)
    expect(state.payments[0]).toMatchObject({ status: "pending", checkout_key: checkoutKey(10, "stripe", 100), created_by: 7 })
    const keys = state.createPayment.mock.calls.map((c: any[]) => c[0].idempotencyKey)
    expect(keys[0]).toBe(keys[1])
    expect(keys[0]).toBe(`inv-1-10-${a.paymentNo}`)
    expect(state.payments[0].reference).toBe("pi_2")
  })

  it("charges only the outstanding balance and keys a new attempt after partial payment", async () => {
    await call("10")
    invoice(1, 10, { amount_paid: 40 })
    const res = await (await call("10")).json()
    expect(res.amount).toBe(60)
    expect(res.replayed).toBe(false)
    expect(state.payments).toHaveLength(2)
  })

  it("releases the key of a failed attempt so a fresh checkout can proceed", async () => {
    await call("10")
    state.payments[0].status = "failed"
    const res = await call("10")
    expect(res.status).toBe(201)
    expect(state.payments[0].checkout_key).toBeNull()
    expect(state.payments[1].checkout_key).toBe(checkoutKey(10, "stripe", 100))
  })

  it("returns 409 when a concurrent request wins the unique key race", async () => {
    state.createPayment = vi.fn(async () => {
      state.payments.push({ id: 999, tenant_id: 1, checkout_key: checkoutKey(10, "stripe", 100), status: "pending" })
      return { providerId: "pi_x", clientParams: {} }
    })
    expect((await call("10")).status).toBe(409)
  })
})

describe("checkout tenant isolation", () => {
  it("cannot open a checkout for another tenant's invoice id", async () => {
    invoice(2, 20)
    const res = await call("20")
    expect(res.status).toBe(404)
    expect(state.createPayment).not.toHaveBeenCalled()
    expect(state.audit.at(-1)).toMatchObject({ result: "denied", entityId: 20 })
  })

  it("keeps idempotency keys partitioned by tenant", async () => {
    invoice(2, 10)
    await call("10")
    state.session = { userId: 9, role: "admin", tenantId: 2 }
    const res = await call("10")
    expect(res.status).toBe(201)
    expect(state.payments.map((p) => p.tenant_id)).toEqual([1, 2])
    expect(state.createPayment.mock.calls[1][0].metadata.tenant_id).toBe("2")
  })

  it("ignores a tenant id smuggled in the body", async () => {
    invoice(2, 20)
    const res = await call("20", { provider: "stripe", tenantId: 2, tenant_id: 2 })
    expect(res.status).toBe(404)
  })
})

describe("checkout failures and audit", () => {
  it("maps gateway errors to 502 without leaking provider detail and audits the failure", async () => {
    state.createPayment = vi.fn(async () => {
      throw new Error("stripe: sk_live_secret invalid")
    })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await call("10")
    spy.mockRestore()
    expect(res.status).toBe(502)
    expect(JSON.stringify(await res.json())).not.toContain("sk_live")
    expect(state.payments).toHaveLength(0)
    expect(state.audit.at(-1)).toMatchObject({ action: "billing.checkout_open", result: "failure" })
  })

  it("audits successful checkouts with replay flag", async () => {
    await call("10")
    await call("10")
    expect(state.audit.map((a) => a.metadata.replayed)).toEqual([false, true])
    expect(state.audit[0]).toMatchObject({ action: "billing.checkout_open", entityType: "billing_invoice", entityId: 10 })
  })
})
