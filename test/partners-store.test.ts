import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec29 (#172) — partner store behavior against an in-memory stand-in for
 * `@/lib/db`. The fake answers exactly the statements the store issues, enforces
 * the same unique keys the schema declares (idempotency key, referral code, one
 * active attribution per tenant, one active membership per user, commission
 * entry_key) and rolls back failed transactions. Unknown SQL throws, so drift
 * between store and fake fails loudly.
 */

type Row = Record<string, any>
type State = {
  partners: Row[]
  members: Row[]
  referrals: Row[]
  commissions: Row[]
  invoices: Row[]
  tenants: Row[]
  users: Row[]
  seq: number
}

const fake = vi.hoisted(() => {
  const h = {
    state: null as any,
    /** Inject a failure for a statement (matched on normalized SQL) once. */
    failOnce: null as null | { match: RegExp; error: Error },
    txChain: Promise.resolve() as Promise<unknown>,
    reset() {
      h.state = {
        partners: [],
        members: [],
        referrals: [],
        commissions: [],
        invoices: [],
        tenants: [],
        users: [],
        seq: 1000,
      }
      h.failOnce = null
    },
  }
  return h
})

function dup(): Error {
  return Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062 })
}

function assertUniqueActive(s: State) {
  const active = s.referrals.filter((r) => r.status === "active").map((r) => r.tenant_id)
  if (new Set(active).size !== active.length) throw dup()
  const members = s.members.filter((m) => m.status === "active").map((m) => m.user_id)
  if (new Set(members).size !== members.length) throw dup()
  const pairs = s.members.map((m) => `${m.partner_id}:${m.user_id}`)
  if (new Set(pairs).size !== pairs.length) throw dup()
}

function exec(rawSql: string, p: any[] = []): any {
  const sql = rawSql.replace(/`/g, "").replace(/\s+/g, " ").trim()
  const s: State = fake.state
  if (fake.failOnce && fake.failOnce.match.test(sql)) {
    const { error } = fake.failOnce
    fake.failOnce = null
    throw error
  }
  const id = () => ++s.seq
  const ok = (affectedRows: number, insertId = 0) => ({ affectedRows, insertId })

  if (sql.includes("information_schema.columns")) return [{ c: 1 }]
  if (/^(CREATE|ALTER)/.test(sql)) return ok(0)

  // --- partners -----------------------------------------------------------
  if (sql.startsWith("SELECT * FROM platform_partners WHERE idempotency_key = ?"))
    return s.partners.filter((r) => r.idempotency_key === p[0])
  if (sql.startsWith("SELECT * FROM platform_partners WHERE id = ?")) return s.partners.filter((r) => r.id === p[0])
  if (sql.startsWith("SELECT * FROM platform_partners WHERE id IN")) return s.partners.filter((r) => p.includes(r.id))
  if (sql.startsWith("SELECT * FROM platform_partners ORDER BY")) return [...s.partners]
  if (sql.startsWith("SELECT id FROM platform_partners WHERE referral_code = ? AND status = 'active'"))
    return s.partners.filter((r) => r.referral_code === p[0] && r.status === "active")
  if (sql.startsWith("INSERT INTO platform_partners")) {
    const [name, kind, contact_email, referral_code, bps, win, start, end, months, idem, created_by] = p
    if (idem && s.partners.some((r) => r.idempotency_key === idem)) throw dup()
    if (s.partners.some((r) => r.referral_code === referral_code)) throw dup()
    const row = {
      id: id(), name, kind, status: "active", contact_email, referral_code, revenue_share_bps: bps,
      refund_window_days: win, contract_start: start, contract_end: end, eligibility_months: months,
      idempotency_key: idem, created_by, created_at: "2027-01-01 00:00:00",
    }
    s.partners.push(row)
    return ok(1, row.id)
  }
  if (sql.startsWith("UPDATE platform_partners SET status = ?")) {
    const row = s.partners.find((r) => r.id === p[6])
    if (!row) return ok(0)
    Object.assign(row, {
      status: p[0], revenue_share_bps: p[1], refund_window_days: p[2], contract_start: p[3], contract_end: p[4], eligibility_months: p[5],
    })
    return ok(1)
  }

  // --- members / users / tenants -----------------------------------------
  if (sql.startsWith("UPDATE platform_partner_members SET status = 'revoked'")) {
    const [by, at, partnerId, userId] = p
    const hit = s.members.filter(
      (m) => m.partner_id === partnerId && m.status === "active" && (!sql.includes("user_id = ?") || m.user_id === userId),
    )
    hit.forEach((m) => Object.assign(m, { status: "revoked", revoked_by: by, revoked_at: at }))
    return ok(hit.length)
  }
  if (sql.startsWith("SELECT id, platform_role FROM users WHERE id = ?")) return s.users.filter((u) => u.id === p[0])
  if (sql.startsWith("SELECT partner_id FROM platform_partner_members WHERE user_id = ? AND status = 'active' AND partner_id <> ?"))
    return s.members.filter((m) => m.user_id === p[0] && m.status === "active" && m.partner_id !== p[1])
  if (sql.startsWith("SELECT id, status FROM platform_partner_members WHERE partner_id = ? AND user_id = ?"))
    return s.members.filter((m) => m.partner_id === p[0] && m.user_id === p[1])
  if (sql.startsWith("SELECT id FROM platform_partner_members WHERE partner_id = ? AND user_id = ? AND status = 'active'"))
    return s.members.filter((m) => m.partner_id === p[0] && m.user_id === p[1] && m.status === "active")
  if (sql.startsWith("UPDATE platform_partner_members SET status = 'active'")) {
    const row = s.members.find((m) => m.id === p[0] && m.status !== "active")
    if (!row) return ok(0)
    const before = { ...row }
    Object.assign(row, { status: "active", revoked_by: null, revoked_at: null })
    try {
      assertUniqueActive(s)
    } catch (e) {
      Object.assign(row, before)
      throw e
    }
    return ok(1)
  }
  if (sql.startsWith("INSERT INTO platform_partner_members")) {
    const row = { id: id(), partner_id: p[0], user_id: p[1], status: "active", created_by: p[2], created_at: "2027-01-01" }
    s.members.push(row)
    try {
      assertUniqueActive(s)
    } catch (e) {
      s.members.pop()
      throw e
    }
    return ok(1, row.id)
  }
  if (sql.startsWith("SELECT m.partner_id FROM platform_partner_members m JOIN platform_partners p")) {
    return s.members
      .filter((m) => m.user_id === p[0] && m.status === "active")
      .filter((m) => s.partners.find((x) => x.id === m.partner_id)?.status === "active")
      .filter((m) => {
        const u = s.users.find((x) => x.id === m.user_id)
        return u && u.status === "active" && (u.platform_role ?? "none") === "none"
      })
      .map((m) => ({ partner_id: m.partner_id }))
  }
  if (sql.startsWith("SELECT m.user_id, m.status, m.revoked_at")) return s.members.filter((m) => m.partner_id === p[0])
  if (sql.startsWith("SELECT id, is_platform_owner FROM tenants WHERE id = ?")) return s.tenants.filter((t) => t.id === p[0])

  // --- referrals ---------------------------------------------------------
  if (sql.startsWith("SELECT * FROM platform_partner_referrals WHERE tenant_id = ? AND status = 'active'"))
    return s.referrals.filter((r) => r.tenant_id === p[0] && r.status === "active")
  if (sql.startsWith("SELECT * FROM platform_partner_referrals WHERE tenant_id = ?"))
    return s.referrals.filter((r) => r.tenant_id === p[0])
  if (sql.startsWith("SELECT * FROM platform_partner_referrals WHERE id = ?")) return s.referrals.filter((r) => r.id === p[0])
  if (sql.startsWith("UPDATE platform_partner_referrals SET status = 'transferred'") || sql.startsWith("UPDATE platform_partner_referrals SET status = 'cancelled'")) {
    const status = sql.includes("'transferred'") ? "transferred" : "cancelled"
    const row = s.referrals.find((r) => r.id === p[3] && r.status === "active")
    if (!row) return ok(0)
    Object.assign(row, { status, ended_at: p[0], ended_reason: p[1], ended_by: p[2] })
    return ok(1)
  }
  if (sql.startsWith("INSERT INTO platform_partner_referrals")) {
    const signup = sql.includes("'signup'")
    const row = signup
      ? { partner_id: p[0], tenant_id: p[1], ownership: "platform", source: "signup", attributed_at: p[2], created_by: p[3] }
      : { partner_id: p[0], tenant_id: p[1], ownership: p[2], source: "platform", attributed_at: p[3], created_by: p[4] }
    const full = { id: id(), status: "active", ended_at: null, ...row }
    s.referrals.push(full)
    try {
      assertUniqueActive(s)
    } catch (e) {
      s.referrals.pop()
      throw e
    }
    return ok(1, full.id)
  }
  if (sql.startsWith("SELECT r.id, r.ownership, r.source, r.status, r.attributed_at, r.ended_at, t.name AS tenant_name")) {
    // Deliberately over-select (like SELECT r.*, t.*) so the test proves the
    // store's projection, not the SQL column list, is what keeps secrets out.
    return s.referrals
      .filter((r) => r.partner_id === p[0])
      .map((r) => {
        const t = s.tenants.find((x) => x.id === r.tenant_id)!
        return { ...t, ...r, tenant_name: t.name }
      })
  }
  if (sql.startsWith("SELECT r.*, t.name AS tenant_name")) {
    return s.referrals
      .filter((r) => r.partner_id === p[0])
      .map((r) => ({ ...r, tenant_name: s.tenants.find((t) => t.id === r.tenant_id)?.name }))
  }

  // --- invoices & commissions -------------------------------------------
  if (sql.startsWith("SELECT * FROM platform_invoices WHERE id = ? FOR UPDATE")) return s.invoices.filter((i) => i.id === p[0])
  if (sql.startsWith("SELECT i.id FROM platform_invoices i WHERE i.status = 'paid'")) {
    const limit = Number(/LIMIT (\d+)/.exec(sql)![1])
    const attributed = new Set(s.referrals.map((r) => r.tenant_id))
    return s.invoices
      .filter((i) => i.status === "paid" && i.paid_at != null && i.id > p[0] && attributed.has(i.tenant_id))
      .filter((i) => !s.commissions.some((c) => c.invoice_id === i.id && c.kind === "commission"))
      .sort((a, b) => a.id - b.id)
      .slice(0, limit)
      .map((i) => ({ id: i.id }))
  }
  if (sql.startsWith("SELECT id FROM platform_partner_commissions WHERE invoice_id = ? AND kind = 'commission'"))
    return s.commissions.filter((c) => c.invoice_id === p[0] && c.kind === "commission")
  if (sql.startsWith("INSERT IGNORE INTO platform_partner_commissions")) {
    const kind = sql.includes("'clawback'") ? "clawback" : "commission"
    const [entry_key, partner_id, referral_id, tenant_id, invoice_id, amount, currency, share_bps, settled_at, created_by] = p
    if (s.commissions.some((c) => c.entry_key === entry_key)) return ok(0)
    s.commissions.push({ id: id(), entry_key, partner_id, referral_id, tenant_id, invoice_id, kind, amount, currency, share_bps, settled_at, created_by })
    return ok(1)
  }
  if (sql.startsWith("SELECT partner_id, referral_id, currency, MAX(")) {
    const groups = new Map<string, Row>()
    for (const c of s.commissions.filter((x) => x.invoice_id === p[0])) {
      const k = `${c.partner_id}:${c.referral_id}:${c.currency}`
      const g = groups.get(k) ?? { partner_id: c.partner_id, referral_id: c.referral_id, currency: c.currency, share_bps: null, net: 0 }
      if (c.kind === "commission") g.share_bps = c.share_bps
      g.net = Math.round((g.net + Number(c.amount)) * 100) / 100
      groups.set(k, g)
    }
    return [...groups.values()].map((g) => ({ ...g, net: g.net.toFixed(2) }))
  }
  if (sql.startsWith("SELECT c.id, c.kind, c.amount")) {
    return s.commissions
      .filter((c) => c.partner_id === p[0])
      .map((c) => ({ ...c, invoice_number: s.invoices.find((i) => i.id === c.invoice_id)?.invoice_number }))
  }

  throw new Error(`fake db: unhandled SQL: ${sql}`)
}

vi.mock("@/lib/db", () => ({
  query: async (sql: string, params?: any[]) => {
    await Promise.resolve()
    return exec(sql, params)
  },
  // Transactions run one at a time (standing in for InnoDB row locks taken by
  // the store's SELECT ... FOR UPDATE), so snapshot rollback is safe.
  withTransaction: (fn: (conn: any) => Promise<any>) => {
    const run = fake.txChain.then(async () => {
      const snapshot = structuredClone(fake.state)
      try {
        return await fn({
          query: async (sql: string, params?: any[]) => {
            await Promise.resolve()
            return [exec(sql, params)]
          },
        })
      } catch (err) {
        fake.state = snapshot
        throw err
      }
    })
    fake.txChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  },
}))
vi.mock("@/lib/platform-console", () => ({ ensureInvoiceRefundSchema: async () => {} }))

const store = await import("@/lib/partners/store")
const { PartnerError, normalizeReferralCode } = await import("@/lib/partners/model")

const TERMS = { revenueShareBps: 2000, refundWindowDays: 30, contractStart: "2027-01-01", contractEnd: null, eligibilityMonths: null }
const ADMIN = 1

async function newPartner(name: string, over: Partial<typeof TERMS> = {}) {
  const { partner } = await store.createPartner(
    { name, kind: "reseller", contactEmail: null, terms: { ...TERMS, ...over } },
    ADMIN,
    null,
  )
  return partner.id
}
function tenant(id: number, over: Row = {}) {
  fake.state.tenants.push({ id, name: `Customer ${id}`, is_platform_owner: 0, db_password: "hunter2", owner_email: `owner${id}@x.test`, ...over })
}
function user(id: number, over: Row = {}) {
  fake.state.users.push({ id, name: `User ${id}`, email: `u${id}@x.test`, status: "active", platform_role: "none", ...over })
}
function invoice(id: number, tenantId: number, over: Row = {}) {
  fake.state.invoices.push({
    id, tenant_id: tenantId, invoice_number: `INV-${id}`, amount: "100.00", refunded_amount: "0.00", currency: "USD",
    status: "paid", issued_at: "2027-02-05 00:00:00", period_start: "2027-02-01", paid_at: "2027-02-06 10:00:00", ...over,
  })
}
const at = (iso: string) => vi.setSystemTime(new Date(iso))
const ledger = (invoiceId?: number) =>
  fake.state.commissions.filter((c: Row) => invoiceId == null || c.invoice_id === invoiceId)
const net = (partnerId: number) =>
  ledger().filter((c: Row) => c.partner_id === partnerId).reduce((a: number, c: Row) => a + Math.round(Number(c.amount) * 100), 0)

async function expectPartnerError(p: Promise<unknown>, code: string, status: number) {
  const err = await p.then(() => null, (e) => e)
  expect(err).toBeInstanceOf(PartnerError)
  expect(err).toMatchObject({ code, status })
}

beforeEach(() => {
  fake.reset()
  vi.useFakeTimers({ toFake: ["Date"] })
  at("2027-02-01T09:00:00Z")
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("partner organizations", () => {
  it("creates once per idempotency key and issues a referral code", async () => {
    const input = { name: "Acme", kind: "reseller" as const, contactEmail: null, terms: TERMS }
    const a = await store.createPartner(input, ADMIN, "idem-key-0001")
    const b = await store.createPartner(input, ADMIN, "idem-key-0001")
    expect(a.replayed).toBe(false)
    expect(b).toMatchObject({ replayed: true, partner: { id: a.partner.id } })
    expect(fake.state.partners).toHaveLength(1)
    expect(a.partner.referralCode).toBeTruthy()
    expect(normalizeReferralCode(a.partner.referralCode)).toBe(a.partner.referralCode)
  })

  it("terminating a partner revokes all dashboard access and cannot be undone", async () => {
    const pid = await newPartner("Acme")
    user(50)
    await store.addMember(pid, 50, ADMIN)
    expect(await store.resolvePartnerForUser(50)).toBe(pid)

    await store.updatePartner(pid, { status: "terminated" }, ADMIN)
    expect(fake.state.members[0]).toMatchObject({ status: "revoked", revoked_by: ADMIN })
    expect(await store.resolvePartnerForUser(50)).toBeNull()
    await expectPartnerError(store.updatePartner(pid, { status: "active" }, ADMIN), "PARTNER_TERMINATED", 409)
    await expectPartnerError(store.addMember(pid, 50, ADMIN), "PARTNER_TERMINATED", 409)
  })
})

describe("scoped referrals and attribution", () => {
  it("attributes once, replays for the same partner and refuses silent takeover", async () => {
    const a = await newPartner("A")
    const b = await newPartner("B")
    tenant(10)
    const first = await store.attributeTenant({ partnerId: a, tenantId: 10, ownership: "partner", transfer: false, actorUserId: ADMIN })
    expect(first).toMatchObject({ replayed: false, previous: null })
    expect(await store.attributeTenant({ partnerId: a, tenantId: 10, ownership: "partner", transfer: false, actorUserId: ADMIN })).toMatchObject({ replayed: true })
    await expectPartnerError(
      store.attributeTenant({ partnerId: b, tenantId: 10, ownership: "partner", transfer: false, actorUserId: ADMIN }),
      "ALREADY_ATTRIBUTED",
      409,
    )
    expect(fake.state.referrals.filter((r: Row) => r.status === "active")).toHaveLength(1)
  })

  it("an explicit transfer ends the old attribution and keeps exactly one active", async () => {
    const a = await newPartner("A")
    const b = await newPartner("B")
    tenant(10)
    await store.attributeTenant({ partnerId: a, tenantId: 10, ownership: "partner", transfer: false, actorUserId: ADMIN })
    const moved = await store.attributeTenant({ partnerId: b, tenantId: 10, ownership: "platform", transfer: true, actorUserId: ADMIN })
    expect(moved.previous?.partnerId).toBe(a)
    expect(fake.state.referrals.map((r: Row) => [r.partner_id, r.status])).toEqual([
      [a, "transferred"],
      [b, "active"],
    ])
  })

  it("concurrent first-time attributions leave one winner and a clean 409", async () => {
    const a = await newPartner("A")
    const b = await newPartner("B")
    tenant(10)
    const results = await Promise.allSettled([
      store.attributeTenant({ partnerId: a, tenantId: 10, ownership: "partner", transfer: false, actorUserId: ADMIN }),
      store.attributeTenant({ partnerId: b, tenantId: 10, ownership: "partner", transfer: false, actorUserId: ADMIN }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: "ALREADY_ATTRIBUTED", status: 409 })
    expect(fake.state.referrals.filter((r: Row) => r.status === "active")).toHaveLength(1)
  })

  it("rejects the platform owner tenant, unknown tenants and inactive partners", async () => {
    const a = await newPartner("A")
    tenant(1, { is_platform_owner: 1 })
    tenant(10)
    await expectPartnerError(store.attributeTenant({ partnerId: a, tenantId: 1, ownership: "partner", transfer: false, actorUserId: ADMIN }), "INVALID_TENANT", 409)
    await expectPartnerError(store.attributeTenant({ partnerId: a, tenantId: 404, ownership: "partner", transfer: false, actorUserId: ADMIN }), "NOT_FOUND", 404)
    await store.updatePartner(a, { status: "suspended" }, ADMIN)
    await expectPartnerError(store.attributeTenant({ partnerId: a, tenantId: 10, ownership: "partner", transfer: false, actorUserId: ADMIN }), "PARTNER_INACTIVE", 409)
  })

  it("signup codes attribute only for active partners and never override an existing owner", async () => {
    const a = await newPartner("A")
    const b = await newPartner("B")
    const codeA = fake.state.partners.find((p: Row) => p.id === a).referral_code
    const codeB = fake.state.partners.find((p: Row) => p.id === b).referral_code
    tenant(10)
    tenant(11)
    expect(await store.attributeSignup(10, "NOPE0000", 99)).toBeNull()
    expect(await store.attributeSignup(10, "bad code!", 99)).toBeNull()
    expect(await store.attributeSignup(10, codeA.toLowerCase(), 99)).toMatchObject({ partnerId: a })
    expect(await store.attributeSignup(10, codeB, 99)).toBeNull()
    await store.updatePartner(b, { status: "suspended" }, ADMIN)
    expect(await store.attributeSignup(11, codeB, 99)).toBeNull()
    expect(fake.state.referrals).toHaveLength(1)
    expect(fake.state.referrals[0]).toMatchObject({ tenant_id: 10, source: "signup", ownership: "platform" })
  })

  it("cancellation is idempotent", async () => {
    const a = await newPartner("A")
    tenant(10)
    const { referral } = await store.attributeTenant({ partnerId: a, tenantId: 10, ownership: "partner", transfer: false, actorUserId: ADMIN })
    expect(await store.cancelReferral(referral.id, "churned", ADMIN)).toMatchObject({ replayed: false, referral: { status: "cancelled" } })
    expect(await store.cancelReferral(referral.id, "churned", ADMIN)).toMatchObject({ replayed: true })
    await expectPartnerError(store.cancelReferral(9999, "x", ADMIN), "NOT_FOUND", 404)
  })
})

describe("commission settlement", () => {
  async function attributed(tenantId = 10, over: Partial<typeof TERMS> = {}) {
    const pid = await newPartner(`P${tenantId}`, over)
    tenant(tenantId)
    await store.attributeTenant({ partnerId: pid, tenantId, ownership: "partner", transfer: false, actorUserId: ADMIN })
    return pid
  }

  it("settles only after verified payment and the refund window, exactly once", async () => {
    const pid = await attributed()
    invoice(1, 10)
    invoice(2, 10, { status: "open", paid_at: null })

    expect((await store.settleCommissions("2027-03-07", null)).skipped).toEqual([{ invoiceId: 1, reason: "refund_window_open" }])
    expect(ledger()).toHaveLength(0)

    const run = await store.settleCommissions("2027-03-08", null)
    expect(run.settled).toEqual([{ invoiceId: 1, partnerId: pid, amount: "20.00" }])
    expect(ledger(2)).toHaveLength(0)

    const again = await Promise.all([store.settleCommissions("2027-03-09", null), store.settleCommissions("2027-03-09", null)])
    expect(again.flatMap((r) => r.settled)).toEqual([])
    expect(ledger(1)).toHaveLength(1)
    expect(ledger(1)[0]).toMatchObject({ kind: "commission", amount: "20.00", share_bps: 2000, entry_key: "commission:1" })
  })

  it("concurrent settlement of the same invoice pays once", async () => {
    await attributed()
    invoice(1, 10)
    const runs = await Promise.all([store.settleCommissions("2027-04-01", null), store.settleCommissions("2027-04-01", null)])
    expect(runs.flatMap((r) => r.settled)).toHaveLength(1)
    expect(ledger(1)).toHaveLength(1)
  })

  it("settles on the net after a refund that lands inside the window", async () => {
    await attributed()
    invoice(1, 10, { refunded_amount: "40.00" })
    await store.settleCommissions("2027-04-01", null)
    expect(ledger(1)[0].amount).toBe("12.00")
  })

  it("pays the owner at issue time across a transfer", async () => {
    const a = await attributed()
    const b = await newPartner("B", { revenueShareBps: 1000 })
    at("2027-03-01T09:00:00Z")
    await store.attributeTenant({ partnerId: b, tenantId: 10, ownership: "partner", transfer: true, actorUserId: ADMIN })
    invoice(1, 10, { issued_at: "2027-02-15 00:00:00", paid_at: "2027-02-16 00:00:00" })
    invoice(2, 10, { issued_at: "2027-03-10 00:00:00", paid_at: "2027-03-11 00:00:00" })
    const run = await store.settleCommissions("2027-06-01", null)
    expect(run.settled).toEqual([
      { invoiceId: 1, partnerId: a, amount: "20.00" },
      { invoiceId: 2, partnerId: b, amount: "10.00" },
    ])
  })

  it("stops earning after cancellation but keeps what was already earned", async () => {
    const pid = await attributed()
    invoice(1, 10, { issued_at: "2027-02-15 00:00:00", paid_at: "2027-02-16 00:00:00" })
    await store.settleCommissions("2027-06-01", null)
    at("2027-03-01T09:00:00Z")
    await store.cancelReferral(fake.state.referrals[0].id, "customer churned", ADMIN)
    invoice(2, 10, { issued_at: "2027-03-10 00:00:00", paid_at: "2027-03-11 00:00:00" })
    const run = await store.settleCommissions("2027-06-01", null)
    expect(run.settled).toEqual([])
    expect(run.skipped).toEqual([{ invoiceId: 2, reason: "not_attributed" }])
    expect(net(pid)).toBe(2000)
  })

  it("defers a suspended partner and pays once reactivated", async () => {
    const pid = await attributed()
    invoice(1, 10)
    await store.updatePartner(pid, { status: "suspended" }, ADMIN)
    expect((await store.settleCommissions("2027-06-01", null)).skipped).toEqual([{ invoiceId: 1, reason: "partner_suspended" }])
    await store.updatePartner(pid, { status: "active" }, ADMIN)
    expect((await store.settleCommissions("2027-06-02", null)).settled).toHaveLength(1)
  })

  it("isolates a failing invoice, rolls it back and still settles the rest", async () => {
    await attributed()
    invoice(1, 10)
    invoice(2, 10)
    fake.failOnce = { match: /INSERT IGNORE INTO platform_partner_commissions/, error: new Error("deadlock") }
    const run = await store.settleCommissions("2027-06-01", null)
    expect(run.failed).toEqual([{ invoiceId: 1 }])
    expect(run.settled.map((s) => s.invoiceId)).toEqual([2])
    expect(ledger(1)).toHaveLength(0)
    expect((await store.settleCommissions("2027-06-02", null)).settled.map((s) => s.invoiceId)).toEqual([1])
  })

  it("is not starved by a backlog of permanently ineligible invoices", async () => {
    await attributed()
    for (let i = 1; i <= store.SETTLEMENT_BATCH_SIZE + 5; i++) invoice(i, 10, { refunded_amount: "100.00" })
    const eligibleId = store.SETTLEMENT_BATCH_SIZE + 6
    invoice(eligibleId, 10)
    const run = await store.settleCommissions("2027-06-01", null)
    expect(run.settled.map((s) => s.invoiceId)).toEqual([eligibleId])
    expect(run.skipped).toHaveLength(store.SETTLEMENT_BATCH_SIZE + 5)
  })
})

describe("refund clawback", () => {
  async function settledInvoice() {
    const pid = await newPartner("A")
    tenant(10)
    await store.attributeTenant({ partnerId: pid, tenantId: 10, ownership: "partner", transfer: false, actorUserId: ADMIN })
    invoice(1, 10)
    await store.settleCommissions("2027-06-01", null)
    return pid
  }
  const refund = (amount: string) => Object.assign(fake.state.invoices[0], { refunded_amount: amount })

  it("claws back proportionally per refund state and ignores replays", async () => {
    const pid = await settledInvoice()
    refund("25.00")
    expect(await store.applyInvoiceClawback(1, ADMIN)).toEqual({ clawbacks: [{ partnerId: pid, amount: "-5.00" }] })
    expect(await store.applyInvoiceClawback(1, ADMIN)).toEqual({ clawbacks: [] })
    refund("60.00")
    expect(await store.applyInvoiceClawback(1, ADMIN)).toEqual({ clawbacks: [{ partnerId: pid, amount: "-7.00" }] })
    expect(net(pid)).toBe(800)
    expect(ledger(1).map((c: Row) => c.entry_key)).toEqual(["commission:1", "clawback:1:" + pid + ":2500", "clawback:1:" + pid + ":6000"])
  })

  it("claws everything back on void and never goes below zero", async () => {
    const pid = await settledInvoice()
    refund("25.00")
    await store.applyInvoiceClawback(1, ADMIN)
    fake.state.invoices[0].status = "void"
    await store.applyInvoiceClawback(1, ADMIN)
    await store.applyInvoiceClawback(1, ADMIN)
    expect(net(pid)).toBe(0)
  })

  it("is a no-op before settlement (settlement will use the net) and for unknown invoices", async () => {
    const pid = await newPartner("A")
    tenant(10)
    await store.attributeTenant({ partnerId: pid, tenantId: 10, ownership: "partner", transfer: false, actorUserId: ADMIN })
    invoice(1, 10, { refunded_amount: "50.00" })
    expect(await store.applyInvoiceClawback(1, ADMIN)).toEqual({ clawbacks: [] })
    expect(await store.applyInvoiceClawback(404, ADMIN)).toEqual({ clawbacks: [] })
    await store.settleCommissions("2027-06-01", null)
    expect(net(pid)).toBe(1000)
  })

  it("rolls back a failed clawback so a retry applies it exactly once", async () => {
    const pid = await settledInvoice()
    refund("50.00")
    fake.failOnce = { match: /INSERT IGNORE INTO platform_partner_commissions/, error: new Error("lock wait timeout") }
    await expect(store.applyInvoiceClawback(1, ADMIN)).rejects.toThrow(/lock wait/)
    expect(net(pid)).toBe(2000)
    await store.applyInvoiceClawback(1, ADMIN)
    await store.applyInvoiceClawback(1, ADMIN)
    expect(net(pid)).toBe(1000)
  })
})

describe("dashboard access and revocation", () => {
  it("grants idempotently and refuses platform staff and cross-partner membership", async () => {
    const a = await newPartner("A")
    const b = await newPartner("B")
    user(50)
    user(60, { platform_role: "platform_staff" })
    expect(await store.addMember(a, 50, ADMIN)).toEqual({ granted: true })
    expect(await store.addMember(a, 50, ADMIN)).toEqual({ granted: false })
    await expectPartnerError(store.addMember(b, 50, ADMIN), "MEMBER_CONFLICT", 409)
    await expectPartnerError(store.addMember(a, 60, ADMIN), "MEMBER_IS_PLATFORM_STAFF", 409)
    await expectPartnerError(store.addMember(a, 404, ADMIN), "NOT_FOUND", 404)
  })

  it("concurrent grants of one user to two partners leave exactly one active membership", async () => {
    const a = await newPartner("A")
    const b = await newPartner("B")
    user(50)
    const results = await Promise.allSettled([store.addMember(a, 50, ADMIN), store.addMember(b, 50, ADMIN)])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "MEMBER_CONFLICT" })
    expect(fake.state.members.filter((m: Row) => m.status === "active")).toHaveLength(1)
  })

  it("revocation, suspension, deactivation and promotion to staff each cut access immediately", async () => {
    const a = await newPartner("A")
    user(50)
    await store.addMember(a, 50, ADMIN)
    expect((await store.getPartnerDashboard(50)).partner).toMatchObject({ name: "A" })

    await store.updatePartner(a, { status: "suspended" }, ADMIN)
    await expectPartnerError(store.getPartnerDashboard(50), "PARTNER_ACCESS_DENIED", 403)
    await store.updatePartner(a, { status: "active" }, ADMIN)
    expect(await store.resolvePartnerForUser(50)).toBe(a)

    fake.state.users[0].status = "inactive"
    expect(await store.resolvePartnerForUser(50)).toBeNull()
    fake.state.users[0].status = "active"

    fake.state.users[0].platform_role = "platform_staff"
    expect(await store.resolvePartnerForUser(50)).toBeNull()
    fake.state.users[0].platform_role = "none"

    expect(await store.revokeMember(a, 50, ADMIN)).toEqual({ revoked: true })
    expect(await store.revokeMember(a, 50, ADMIN)).toEqual({ revoked: false })
    await expectPartnerError(store.getPartnerDashboard(50), "PARTNER_ACCESS_DENIED", 403)

    expect(await store.addMember(a, 50, ADMIN)).toEqual({ granted: true })
    expect(await store.resolvePartnerForUser(50)).toBe(a)
  })

  it("shows each partner only its own customers and ledger, without customer secrets", async () => {
    const a = await newPartner("A")
    const b = await newPartner("B")
    tenant(10)
    tenant(20)
    user(50)
    user(70)
    await store.addMember(a, 50, ADMIN)
    await store.addMember(b, 70, ADMIN)
    await store.attributeTenant({ partnerId: a, tenantId: 10, ownership: "partner", transfer: false, actorUserId: ADMIN })
    await store.attributeTenant({ partnerId: b, tenantId: 20, ownership: "partner", transfer: false, actorUserId: ADMIN })
    invoice(1, 10)
    invoice(2, 20, { amount: "500.00" })
    await store.settleCommissions("2027-06-01", null)

    const dash = await store.getPartnerDashboard(50)
    expect(dash.referrals.map((r) => r.customerName)).toEqual(["Customer 10"])
    expect(dash.commissions.map((c) => c.invoiceNumber)).toEqual(["INV-1"])
    expect(dash.totals).toEqual({ earned: "20.00", clawedBack: "0.00", net: "20.00" })

    const payload = JSON.stringify(dash)
    for (const leak of ["hunter2", "owner10@", "Customer 20", "INV-2", "idempotency", "created_by", "tenant_id", "contact_email"]) {
      expect(payload).not.toContain(leak)
    }
  })
})
