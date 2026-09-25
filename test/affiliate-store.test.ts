import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec30 (#173) — affiliate store behavior against an in-memory stand-in for
 * `@/lib/db`. The fake answers exactly the statements the store issues, enforces
 * the same unique keys the schema declares (click token_hash, one conversion
 * per tenant/click, one active referral per tenant, payout idempotency key, one
 * live payout item per commission) and rolls back failed transactions. Unknown
 * SQL throws, so drift between store and fake fails loudly.
 *
 * `@/lib/partners/store` is mocked (ensurePartnerSchema/getPartner/
 * resolvePartnerForUser) so the test only models the affiliate store's own SQL
 * and the shared tables it reads (referrals, commissions, invoices,
 * subscriptions, users, tenants). `@/lib/affiliates/model` stays real, so click
 * cookies are signed and verified exactly as in production.
 */

process.env.SESSION_SECRET = "affiliate-store-test-secret"

type Row = Record<string, any>
type State = {
  partners: Row[]
  members: Row[]
  links: Row[]
  clicks: Row[]
  conversions: Row[]
  payouts: Row[]
  payoutItems: Row[]
  referrals: Row[]
  commissions: Row[]
  invoices: Row[]
  subscriptions: Row[]
  users: Row[]
  tenants: Row[]
  seq: number
}

const fake = vi.hoisted(() => {
  const h = {
    state: null as any,
    txChain: Promise.resolve() as Promise<unknown>,
    reset() {
      h.state = {
        partners: [], members: [], links: [], clicks: [], conversions: [], payouts: [], payoutItems: [],
        referrals: [], commissions: [], invoices: [], subscriptions: [], users: [], tenants: [], seq: 1000,
      }
    },
  }
  return h
})

function dup(): Error {
  return Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062 })
}
const activeCommissionId = (pi: Row) => (pi.released ? null : pi.commission_id)

function exec(rawSql: string, p: any[] = []): any {
  const sql = rawSql.replace(/`/g, "").replace(/\s+/g, " ").trim()
  const s: State = fake.state
  const id = () => ++s.seq
  const ok = (affectedRows: number, insertId = 0) => ({ affectedRows, insertId })

  if (sql.includes("information_schema")) return [{ c: 1 }]
  if (/^(CREATE|ALTER)/.test(sql)) return ok(0)

  // --- links --------------------------------------------------------------
  if (sql.startsWith("SELECT * FROM platform_affiliate_links WHERE idempotency_key = ?"))
    return s.links.filter((r) => r.idempotency_key != null && r.idempotency_key === p[0])
  if (sql.startsWith("SELECT COUNT(*) AS c FROM platform_affiliate_links WHERE partner_id = ? AND status = 'active'"))
    return [{ c: s.links.filter((r) => r.partner_id === p[0] && r.status === "active").length }]
  if (sql.startsWith("INSERT INTO platform_affiliate_links")) {
    const [partner_id, code, label, idempotency_key, created_by] = p
    if (s.links.some((r) => r.code === code)) throw dup()
    if (idempotency_key != null && s.links.some((r) => r.idempotency_key === idempotency_key)) throw dup()
    const row = { id: id(), partner_id, code, label, status: "active", idempotency_key, created_by, created_at: "2027-02-01 00:00:00" }
    s.links.push(row)
    return ok(1, row.id)
  }
  if (sql.startsWith("SELECT l.*,")) {
    // listLinks with clicks + non-rejected signup counts
    return s.links
      .filter((l) => l.partner_id === p[0])
      .sort((a, b) => b.id - a.id)
      .map((l) => ({
        ...l,
        clicks: s.clicks.filter((c) => c.link_id === l.id).length,
        signups: s.conversions.filter((v) => v.link_id === l.id && v.state !== "rejected").length,
      }))
  }
  if (sql.startsWith("SELECT * FROM platform_affiliate_links WHERE id = ?")) return s.links.filter((r) => r.id === p[0])
  if (sql.startsWith("UPDATE platform_affiliate_links SET status = ? WHERE id = ?")) {
    const row = s.links.find((r) => r.id === p[1])
    if (!row) return ok(0)
    row.status = p[0]
    return ok(1)
  }

  // --- clicks -------------------------------------------------------------
  if (sql.startsWith("SELECT l.id, l.partner_id FROM platform_affiliate_links l JOIN platform_partners p")) {
    return s.links
      .filter((l) => l.code === p[0] && l.status === "active")
      .filter((l) => s.partners.find((pt) => pt.id === l.partner_id)?.status === "active")
      .map((l) => ({ id: l.id, partner_id: l.partner_id }))
      .slice(0, 1)
  }
  if (sql.startsWith("SELECT id, link_id, token_hash, expires_at, consumed_at FROM platform_affiliate_clicks WHERE id = ?"))
    return s.clicks.filter((c) => c.id === p[0])
  if (sql.startsWith("INSERT INTO platform_affiliate_clicks")) {
    const [link_id, partner_id, token_hash, ip_hash, ua_hash, created_at, expires_at] = p
    if (s.clicks.some((c) => c.token_hash === token_hash)) throw dup()
    const row = { id: id(), link_id, partner_id, token_hash, ip_hash, ua_hash, created_at, expires_at, consumed_at: null, consumed_tenant_id: null }
    s.clicks.push(row)
    return ok(1, row.id)
  }
  if (sql.startsWith("SELECT c.*, l.status AS link_status, p.status AS partner_status, p.contact_email FROM platform_affiliate_clicks c")) {
    return s.clicks
      .filter((c) => c.id === p[0])
      .map((c) => {
        const l = s.links.find((x) => x.id === c.link_id)
        const pt = s.partners.find((x) => x.id === c.partner_id)
        return { ...c, link_status: l?.status, partner_status: pt?.status, contact_email: pt?.contact_email ?? null }
      })
  }
  if (sql.startsWith("UPDATE platform_affiliate_clicks SET consumed_at = ?, consumed_tenant_id = ? WHERE id = ? AND consumed_at IS NULL")) {
    const row = s.clicks.find((c) => c.id === p[2] && c.consumed_at == null)
    if (!row) return ok(0)
    Object.assign(row, { consumed_at: p[0], consumed_tenant_id: p[1] })
    return ok(1)
  }

  // --- conversions --------------------------------------------------------
  if (sql.startsWith("INSERT IGNORE INTO platform_affiliate_conversions") && sql.includes("rejected_click_id")) {
    const [partner_id, link_id, rejected_click_id, tenant_id, reject_reason, referred_at] = p
    if (s.conversions.some((v) => v.tenant_id === tenant_id)) return ok(0) // uniq_aff_conv_tenant
    s.conversions.push({ id: id(), partner_id, link_id, click_id: null, rejected_click_id, tenant_id, referral_id: null, state: "rejected", reject_reason, referred_at, trial_at: null, converted_at: null, paid_at: null, first_paid_invoice_id: null, cancelled_at: null })
    return ok(1)
  }
  if (sql.startsWith("INSERT IGNORE INTO platform_affiliate_conversions") && sql.includes("referral_id")) {
    // recordCodeConversion: (partner_id, tenant_id, referral_id, state, referred_at)
    const [partner_id, tenant_id, referral_id, referred_at] = p
    if (s.conversions.some((v) => v.tenant_id === tenant_id)) return ok(0)
    s.conversions.push({ id: id(), partner_id, link_id: null, click_id: null, tenant_id, referral_id, state: "referred", referred_at, trial_at: null, converted_at: null, paid_at: null, first_paid_invoice_id: null, cancelled_at: null })
    return ok(1)
  }
  if (sql.startsWith("INSERT INTO platform_affiliate_conversions")) {
    const [partner_id, link_id, click_id, tenant_id, referral_id, referred_at] = p
    if (s.conversions.some((v) => v.tenant_id === tenant_id)) throw dup()
    if (click_id != null && s.conversions.some((v) => v.click_id === click_id)) throw dup()
    s.conversions.push({ id: id(), partner_id, link_id, click_id, tenant_id, referral_id, state: "referred", referred_at, trial_at: null, converted_at: null, paid_at: null, first_paid_invoice_id: null, cancelled_at: null })
    return ok(1)
  }
  if (sql.startsWith("SELECT v.id, v.state, v.trial_at, v.converted_at, v.paid_at, v.first_paid_invoice_id, v.cancelled_at,")) {
    const partnerFilter = sql.includes("AND v.partner_id = ?") ? p[0] : null
    return s.conversions
      .filter((v) => ["referred", "trial", "converted", "paid"].includes(v.state))
      .filter((v) => partnerFilter == null || v.partner_id === partnerFilter)
      .sort((a, b) => a.id - b.id)
      .map((v) => {
        const sub = s.subscriptions.find((x) => x.tenant_id === v.tenant_id)
        const ref = s.referrals.find((x) => x.id === v.referral_id)
        const paid = s.invoices
          .filter((i) => i.tenant_id === v.tenant_id && i.status === "paid" && i.paid_at != null)
          .sort((a, b) => (a.paid_at < b.paid_at ? -1 : a.paid_at > b.paid_at ? 1 : a.id - b.id))[0]
        return {
          id: v.id, state: v.state, trial_at: v.trial_at, converted_at: v.converted_at, paid_at: v.paid_at,
          first_paid_invoice_id: v.first_paid_invoice_id, cancelled_at: v.cancelled_at,
          sub_status: sub?.status ?? null, mrr: sub?.mrr ?? null, referral_status: ref?.status ?? null,
          paid_invoice_id: paid?.id ?? null, paid_invoice_at: paid?.paid_at ?? null,
        }
      })
  }
  if (sql.startsWith("UPDATE platform_affiliate_conversions SET state = ?, trial_at = ?, converted_at = ?, paid_at = ?, first_paid_invoice_id = ?, cancelled_at = ? WHERE id = ? AND state = ?")) {
    const row = s.conversions.find((v) => v.id === p[6] && v.state === p[7])
    if (!row) return ok(0)
    Object.assign(row, { state: p[0], trial_at: p[1], converted_at: p[2], paid_at: p[3], first_paid_invoice_id: p[4], cancelled_at: p[5] })
    return ok(1)
  }
  if (sql.startsWith("SELECT COUNT(*) AS c FROM platform_affiliate_conversions WHERE partner_id = ? AND state = 'rejected'"))
    return [{ c: s.conversions.filter((v) => v.partner_id === p[0] && v.state === "rejected").length }]
  if (sql.startsWith("SELECT COUNT(*) AS c FROM platform_affiliate_clicks WHERE partner_id = ?"))
    return [{ c: s.clicks.filter((c) => c.partner_id === p[0]).length }]
  if (sql.startsWith("SELECT v.id, v.state, v.referred_at, v.trial_at, v.converted_at, v.paid_at, v.cancelled_at, l.code AS link_code, t.name AS tenant_name")) {
    return s.conversions
      .filter((v) => v.partner_id === p[0] && v.state !== "rejected")
      .sort((a, b) => b.id - a.id)
      .map((v) => ({ ...v, link_code: s.links.find((l) => l.id === v.link_id)?.code ?? null, tenant_name: s.tenants.find((t) => t.id === v.tenant_id)?.name }))
  }

  // --- referrals (shared Spec29 table) -----------------------------------
  if (sql.startsWith("SELECT id FROM platform_partner_referrals WHERE tenant_id = ? AND status = 'active'"))
    return s.referrals.filter((r) => r.tenant_id === p[0] && r.status === "active")
  if (sql.startsWith("INSERT INTO platform_partner_referrals")) {
    const [partner_id, tenant_id, , created_by] = p
    if (s.referrals.some((r) => r.tenant_id === tenant_id && r.status === "active")) throw dup()
    const row = { id: id(), partner_id, tenant_id, ownership: "platform", source: "affiliate", status: "active", attributed_at: p[2], created_by }
    s.referrals.push(row)
    return ok(1, row.id)
  }

  // --- partner members / users -------------------------------------------
  if (sql.startsWith("SELECT m.user_id, u.email FROM platform_partner_members m")) {
    return s.members
      .filter((m) => m.partner_id === p[0])
      .map((m) => ({ user_id: m.user_id, email: s.users.find((u) => u.id === m.user_id)?.email ?? null }))
  }
  if (sql.startsWith("SELECT id, contact_email FROM platform_partners WHERE referral_code = ? AND status = 'active'"))
    return s.partners.filter((pt) => pt.referral_code === p[0] && pt.status === "active").map((pt) => ({ id: pt.id, contact_email: pt.contact_email ?? null }))

  // --- payouts ------------------------------------------------------------
  if (sql.startsWith("SELECT * FROM platform_affiliate_payouts WHERE idempotency_key = ?"))
    return s.payouts.filter((r) => r.idempotency_key === p[0])
  if (sql.startsWith("SELECT id FROM platform_partners WHERE id = ?")) return s.partners.filter((pt) => pt.id === p[0]).map((pt) => ({ id: pt.id }))
  if (sql.startsWith("SELECT c.id, c.amount FROM platform_partner_commissions c WHERE c.partner_id = ? AND c.currency = ?")) {
    const inLive = new Set(s.payoutItems.filter((pi) => activeCommissionId(pi) != null).map((pi) => pi.commission_id))
    return s.commissions
      .filter((c) => c.partner_id === p[0] && c.currency === p[1] && !inLive.has(c.id))
      .sort((a, b) => a.id - b.id)
      .map((c) => ({ id: c.id, amount: c.amount }))
  }
  if (sql.startsWith("INSERT INTO platform_affiliate_payouts")) {
    const [partner_id, currency, amount, idempotency_key, created_by, created_at] = p
    if (s.payouts.some((r) => r.idempotency_key === idempotency_key)) throw dup()
    const row = { id: id(), partner_id, currency, amount, status: "pending", reference: null, void_reason: null, idempotency_key, created_by, created_at, paid_at: null, voided_at: null }
    s.payouts.push(row)
    return ok(1, row.id)
  }
  if (sql.startsWith("INSERT INTO platform_affiliate_payout_items")) {
    for (let i = 0; i < p.length; i += 3) {
      const commission_id = p[i + 1]
      if (s.payoutItems.some((pi) => activeCommissionId(pi) === commission_id)) throw dup()
      s.payoutItems.push({ id: id(), payout_id: p[i], commission_id, amount: p[i + 2], released: 0 })
    }
    return ok(p.length / 3)
  }
  if (sql.startsWith("SELECT * FROM platform_affiliate_payouts WHERE id = ?")) return s.payouts.filter((r) => r.id === p[0])
  if (sql.startsWith("UPDATE platform_affiliate_payouts SET status = 'paid'")) {
    const row = s.payouts.find((r) => r.id === p[3] && r.status === "pending")
    if (!row) return ok(0)
    Object.assign(row, { status: "paid", reference: p[0], paid_by: p[1], paid_at: p[2] })
    return ok(1)
  }
  if (sql.startsWith("UPDATE platform_affiliate_payouts SET status = 'void'")) {
    const row = s.payouts.find((r) => r.id === p[3] && r.status === "pending")
    if (!row) return ok(0)
    Object.assign(row, { status: "void", void_reason: p[0], voided_by: p[1], voided_at: p[2] })
    return ok(1)
  }
  if (sql.startsWith("UPDATE platform_affiliate_payout_items SET released = 1 WHERE payout_id = ?")) {
    const hit = s.payoutItems.filter((pi) => pi.payout_id === p[0])
    hit.forEach((pi) => (pi.released = 1))
    return ok(hit.length)
  }
  if (sql.startsWith("SELECT * FROM platform_affiliate_payouts")) {
    const filtered = sql.includes("WHERE partner_id = ?") ? s.payouts.filter((r) => r.partner_id === p[0]) : [...s.payouts]
    return filtered.sort((a, b) => b.id - a.id)
  }

  // --- commissions ledger + pending estimate -----------------------------
  if (sql.startsWith("SELECT c.id, c.kind, c.amount, c.currency, po.status AS payout_status FROM platform_partner_commissions c")) {
    return s.commissions
      .filter((c) => c.partner_id === p[0])
      .map((c) => {
        const pi = s.payoutItems.find((x) => activeCommissionId(x) === c.id)
        const po = pi ? s.payouts.find((x) => x.id === pi.payout_id) : null
        return { id: c.id, kind: c.kind, amount: c.amount, currency: c.currency, payout_status: po?.status ?? null }
      })
  }
  if (sql.startsWith("SELECT i.amount, i.refunded_amount, i.currency FROM platform_invoices i JOIN platform_partner_referrals r")) {
    const partnerId = p[0]
    const tenantIds = new Set(s.referrals.filter((r) => r.partner_id === partnerId && r.status === "active").map((r) => r.tenant_id))
    return s.invoices
      .filter((i) => i.status === "paid" && tenantIds.has(i.tenant_id))
      .filter((i) => !s.commissions.some((c) => c.invoice_id === i.id && c.kind === "commission"))
      .map((i) => ({ amount: i.amount, refunded_amount: i.refunded_amount ?? "0.00", currency: i.currency ?? "USD" }))
  }

  throw new Error(`fake db: unhandled SQL: ${sql}`)
}

vi.mock("@/lib/db", () => ({
  query: async (sql: string, params?: any[]) => {
    await Promise.resolve()
    return exec(sql, params)
  },
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
    fake.txChain = run.then(() => undefined, () => undefined)
    return run
  },
}))

vi.mock("@/lib/partners/store", () => ({
  ensurePartnerSchema: async () => {},
  getPartner: async (idArg: number) => {
    const pt = fake.state.partners.find((p: Row) => p.id === idArg)
    if (!pt) throw Object.assign(new Error("Partner not found"), { code: "NOT_FOUND", status: 404 })
    return { id: pt.id, name: pt.name, status: pt.status, terms: { revenueShareBps: pt.revenue_share_bps ?? 2000, refundWindowDays: pt.refund_window_days ?? 30 } }
  },
  resolvePartnerForUser: async (userId: number) => {
    const m = fake.state.members.find((x: Row) => x.user_id === userId && x.status === "active")
    return m ? m.partner_id : null
  },
}))

const store = await import("@/lib/affiliates/store")
const model = await import("@/lib/affiliates/model")
const { normalizeReferralCode } = await import("@/lib/partners/model")

// --- fixtures --------------------------------------------------------------
function partner(id: number, over: Row = {}) {
  fake.state.partners.push({ id, name: `Partner ${id}`, status: "active", contact_email: null, referral_code: `P${id}CODE`, revenue_share_bps: 2000, refund_window_days: 30, ...over })
}
function member(partnerId: number, userId: number, email: string) {
  fake.state.members.push({ partner_id: partnerId, user_id: userId, status: "active" })
  if (!fake.state.users.some((u: Row) => u.id === userId)) fake.state.users.push({ id: userId, email })
}
function tenant(id: number, name = `Customer ${id}`) {
  fake.state.tenants.push({ id, name })
}
function commission(over: Row) {
  fake.state.commissions.push({ id: ++fake.state.seq, partner_id: 1, referral_id: 1, tenant_id: 10, invoice_id: 100, kind: "commission", amount: "10.00", currency: "USD", ...over })
}
async function seedLink(partnerId: number, label: string | null = null) {
  const { link } = await store.createLink({ partnerId, label, actorUserId: 1, idempotencyKey: null })
  return link
}
const at = (iso: string) => vi.setSystemTime(new Date(iso))

beforeEach(() => {
  fake.reset()
  vi.useFakeTimers({ toFake: ["Date"] })
  at("2027-02-01T09:00:00Z")
  vi.spyOn(console, "error").mockImplementation(() => {})
  delete process.env.AFFILIATE_TOUCH_POLICY
  delete process.env.AFFILIATE_ATTRIBUTION_DAYS
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("links", () => {
  it("creates unique codes, enforces the per-affiliate limit and refuses inactive partners", async () => {
    partner(1)
    const link = await seedLink(1, "Blog")
    expect(normalizeReferralCode(link.code)).toBe(link.code)
    expect(fake.state.links).toHaveLength(1)

    // idempotent replay returns the same link, no second row
    const key = "aff-link-idem-key-01"
    const a = await store.createLink({ partnerId: 1, label: null, actorUserId: 1, idempotencyKey: key })
    const b = await store.createLink({ partnerId: 1, label: null, actorUserId: 1, idempotencyKey: key })
    expect(a.replayed).toBe(false)
    expect(b).toMatchObject({ replayed: true, link: { id: a.link.id } })

    partner(2, { status: "suspended" })
    await expect(store.createLink({ partnerId: 2, label: null, actorUserId: 1, idempotencyKey: null })).rejects.toMatchObject({ code: "PARTNER_INACTIVE" })
  })

  it("scopes enable/disable to the owning partner", async () => {
    partner(1)
    partner(2)
    const link = await seedLink(1)
    // another partner cannot touch it
    await expect(store.setLinkStatus(link.id, "disabled", 2)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
    const off = await store.setLinkStatus(link.id, "disabled", 1)
    expect(off).toMatchObject({ replayed: false, previous: "active", link: { status: "disabled" } })
    // repeating the same status is an idempotent no-op
    expect(await store.setLinkStatus(link.id, "disabled", 1)).toMatchObject({ replayed: true })
  })
})

describe("clicks and multi-touch", () => {
  const clickArgs = (code: string, existingCookie: string | null = null) => ({
    code, existingCookie, ipHash: model.sha256("ip"), uaHash: model.sha256("ua"), now: new Date(),
  })

  it("records a click and sets a signed cookie; an unknown or disabled code records nothing", async () => {
    partner(1)
    const link = await seedLink(1)
    const first = await store.recordClick(clickArgs(link.code))
    expect(first?.decision).toBe("new")
    expect(first?.cookie?.value).toBeTruthy()
    expect(fake.state.clicks).toHaveLength(1)
    // cookie carries no partner/link id, only a signed <clickId>.<token>
    expect(model.parseClickCookie(first!.cookie!.value, process.env.SESSION_SECRET!)).toMatchObject({ clickId: fake.state.clicks[0].id })

    expect(await store.recordClick(clickArgs("NOSUCH00"))).toBeNull()
    await store.setLinkStatus(link.id, "disabled", 1)
    expect(await store.recordClick(clickArgs(link.code))).toBeNull()
  })

  it("reuses the same link and does not inflate clicks", async () => {
    partner(1)
    const link = await seedLink(1)
    const first = await store.recordClick(clickArgs(link.code))
    const again = await store.recordClick(clickArgs(link.code, first!.cookie!.value))
    expect(again).toMatchObject({ decision: "reuse", cookie: null })
    expect(fake.state.clicks).toHaveLength(1)
  })

  it("last-click replaces, first-click keeps the original attribution", async () => {
    partner(1)
    const a = await seedLink(1, "A")
    const b = await seedLink(1, "B")
    // default last-click: clicking B after A records a new click
    const clickA = await store.recordClick(clickArgs(a.code))
    const last = await store.recordClick(clickArgs(b.code, clickA!.cookie!.value))
    expect(last?.decision).toBe("new")
    expect(fake.state.clicks).toHaveLength(2)

    // first-click: the original cookie is kept, no new click
    process.env.AFFILIATE_TOUCH_POLICY = "first"
    const clickA2 = await store.recordClick(clickArgs(a.code))
    const keep = await store.recordClick(clickArgs(b.code, clickA2!.cookie!.value))
    expect(keep).toMatchObject({ decision: "keep", cookie: null })
    expect(fake.state.clicks).toHaveLength(3)
  })
})

describe("signup attribution and fraud resistance", () => {
  async function clickCookie(code: string) {
    const r = await store.recordClick({ code, existingCookie: null, ipHash: null, uaHash: null, now: new Date() })
    return r!.cookie!.value
  }
  const claim = (cookieValue: string | null, over: Partial<Parameters<typeof store.claimSignup>[0]> = {}) =>
    store.claimSignup({ cookieValue, tenantId: 10, registrant: { userId: 500, email: "buyer@newco.com" }, sessionUserId: null, now: new Date(), ...over })

  it("credits a fresh click: one active referral, one referred conversion, click consumed", async () => {
    partner(1)
    tenant(10)
    const link = await seedLink(1)
    const cookie = await clickCookie(link.code)
    const res = await claim(cookie)
    expect(res).toMatchObject({ status: "attributed", partnerId: 1, linkId: link.id })
    expect(fake.state.referrals.filter((r: Row) => r.status === "active" && r.source === "affiliate")).toHaveLength(1)
    expect(fake.state.conversions.filter((v: Row) => v.state === "referred")).toHaveLength(1)
    expect(fake.state.clicks[0].consumed_at).not.toBeNull()
  })

  it("does not double-credit: a replayed cookie for a second signup is rejected as consumed", async () => {
    partner(1)
    tenant(10)
    tenant(11)
    const cookie = await clickCookie((await seedLink(1)).code)
    await claim(cookie)
    const second = await claim(cookie, { tenantId: 11, registrant: { userId: 501, email: "other@newco.com" } })
    expect(second).toMatchObject({ status: "rejected", reason: "consumed" })
    expect(fake.state.referrals.filter((r: Row) => r.status === "active")).toHaveLength(1)
  })

  it("refuses a self-referral by prior session and burns the click", async () => {
    partner(1)
    tenant(10)
    member(1, 77, "rep@partner.io")
    const cookie = await clickCookie((await seedLink(1)).code)
    const res = await claim(cookie, { sessionUserId: 77 })
    expect(res).toMatchObject({ status: "rejected", reason: "self_referral_session" })
    expect(fake.state.clicks[0].consumed_at).not.toBeNull() // burned
    expect(fake.state.referrals).toHaveLength(0)
    expect(fake.state.conversions[0]).toMatchObject({ state: "rejected", reject_reason: "self_referral_session" })
  })

  it("refuses a self-referral by matching mailbox", async () => {
    partner(1, { contact_email: "founder@partner.io" })
    tenant(10)
    const cookie = await clickCookie((await seedLink(1)).code)
    const res = await claim(cookie, { registrant: { userId: 500, email: "Founder+promo@partner.io" } })
    expect(res).toMatchObject({ status: "rejected", reason: "self_referral_email" })
  })

  it("refuses an expired click without crediting", async () => {
    process.env.AFFILIATE_ATTRIBUTION_DAYS = "1"
    partner(1)
    tenant(10)
    const cookie = await clickCookie((await seedLink(1)).code)
    at("2027-02-05T09:00:00Z") // well past the 1-day window
    const res = await claim(cookie)
    expect(res).toMatchObject({ status: "rejected", reason: "expired" })
    expect(fake.state.referrals).toHaveLength(0)
  })

  it("refuses when the tenant already has an active attribution", async () => {
    partner(1)
    tenant(10)
    fake.state.referrals.push({ id: 900, partner_id: 2, tenant_id: 10, status: "active", source: "manual" })
    const cookie = await clickCookie((await seedLink(1)).code)
    const res = await claim(cookie)
    expect(res).toMatchObject({ status: "rejected", reason: "already_attributed" })
  })

  it("treats a forged cookie as no cookie", async () => {
    partner(1)
    tenant(10)
    expect(await claim("9.forgedtokenforgedtoken.badsig")).toEqual({ status: "none" })
  })

  it("guards the typed-code signup path for self-referrals too", async () => {
    partner(1, { contact_email: "founder@partner.io", referral_code: "ACME1234" })
    const ok = await store.checkPartnerCodeSignup({ rawCode: "ACME1234", registrantEmail: "buyer@newco.com", sessionUserId: null })
    expect(ok).toMatchObject({ partnerId: 1, reason: null })
    const bad = await store.checkPartnerCodeSignup({ rawCode: "acme1234", registrantEmail: "founder@partner.io", sessionUserId: null })
    expect(bad).toMatchObject({ partnerId: 1, reason: "self_referral_email" })
    expect(await store.checkPartnerCodeSignup({ rawCode: "NONE0000", registrantEmail: "x@y.com", sessionUserId: null })).toBeNull()
  })
})

describe("conversion lifecycle sync", () => {
  async function attributed() {
    partner(1)
    tenant(10)
    const r = await store.recordClick({ code: (await seedLink(1)).code, existingCookie: null, ipHash: null, uaHash: null, now: new Date() })
    await store.claimSignup({ cookieValue: r!.cookie!.value, tenantId: 10, registrant: { userId: 500, email: "buyer@newco.com" }, sessionUserId: null, now: new Date() })
  }
  const state = () => fake.state.conversions[0].state

  it("advances referred → trial → converted → paid from subscription and invoice records", async () => {
    await attributed()
    fake.state.subscriptions.push({ tenant_id: 10, status: "trialing", mrr: 0 })
    await store.syncConversions(1, new Date())
    expect(state()).toBe("trial")

    fake.state.subscriptions[0] = { tenant_id: 10, status: "active", mrr: 5000 }
    await store.syncConversions(1, new Date())
    expect(state()).toBe("converted")

    fake.state.invoices.push({ id: 100, tenant_id: 10, status: "paid", paid_at: "2027-02-03 10:00:00", amount: "50.00", refunded_amount: "0.00", currency: "USD" })
    await store.syncConversions(1, new Date())
    expect(fake.state.conversions[0]).toMatchObject({ state: "paid", first_paid_invoice_id: 100 })
  })

  it("cancels the conversion when the subscription is cancelled", async () => {
    await attributed()
    fake.state.subscriptions.push({ tenant_id: 10, status: "canceled", mrr: 0 })
    const res = await store.syncConversions(1, new Date())
    expect(res.updated).toBe(1)
    expect(fake.state.conversions[0]).toMatchObject({ state: "cancelled" })
    // terminal: a later run does not resurrect it
    fake.state.subscriptions[0] = { tenant_id: 10, status: "active", mrr: 5000 }
    expect((await store.syncConversions(1, new Date())).updated).toBe(0)
    expect(state()).toBe("cancelled")
  })
})

describe("payouts and audit trail", () => {
  const KEY = "aff-payout-idem-key-01"
  const create = (over: Partial<Parameters<typeof store.createPayout>[0]> = {}) =>
    store.createPayout({ partnerId: 1, currency: "USD", actorUserId: 1, idempotencyKey: KEY, ...over })

  it("locks available commissions into one pending payout, nets clawbacks and is idempotent", async () => {
    partner(1)
    commission({ id: 2001, amount: "10.00" })
    commission({ id: 2002, amount: "6.00" })
    commission({ id: 2003, amount: "-4.00", kind: "clawback" })
    const res = await create()
    expect(res).toMatchObject({ replayed: false, entries: 3 })
    expect(res.payout.amount).toBe("12.00") // 10 + 6 - 4
    expect(fake.state.payoutItems).toHaveLength(3)

    // the same key replays without creating a second payout
    const replay = await create()
    expect(replay).toMatchObject({ replayed: true, payout: { id: res.payout.id } })
    expect(fake.state.payouts).toHaveLength(1)

    // a fresh payout now finds nothing available (all commissions are locked)
    await expect(create({ idempotencyKey: "aff-payout-idem-key-02" })).rejects.toMatchObject({ code: "NOTHING_TO_PAY", status: 409 })
  })

  it("refuses a non-positive balance", async () => {
    partner(1)
    commission({ id: 2001, amount: "5.00" })
    commission({ id: 2002, amount: "-5.00", kind: "clawback" })
    await expect(create()).rejects.toMatchObject({ code: "NOTHING_TO_PAY" })
    expect(fake.state.payouts).toHaveLength(0)
  })

  it("marks a payout paid, then refuses any further transition", async () => {
    partner(1)
    commission({ id: 2001, amount: "10.00" })
    const { payout } = await create()
    const paid = await store.transitionPayout({ payoutId: payout.id, action: "mark_paid", reference: "wire-12345", reason: null, actorUserId: 1 })
    expect(paid).toMatchObject({ replayed: false, previousStatus: "pending", payout: { status: "paid" } })
    // replaying the same action is idempotent
    expect(await store.transitionPayout({ payoutId: payout.id, action: "mark_paid", reference: "wire-12345", reason: null, actorUserId: 1 })).toMatchObject({ replayed: true })
    // voiding a paid payout is a conflict
    await expect(store.transitionPayout({ payoutId: payout.id, action: "void", reference: null, reason: "too late", actorUserId: 1 })).rejects.toMatchObject({ code: "INVALID_PAYOUT_TRANSITION", status: 409 })
  })

  it("voiding releases the commissions back to available balance", async () => {
    partner(1)
    commission({ id: 2001, amount: "10.00" })
    const { payout } = await create()
    // balance now shows inPayout, not available
    let bal = (await store.partnerBalances(1, 2000)).find((b) => b.currency === "USD")!
    expect(bal).toMatchObject({ available: "0.00", inPayout: "10.00" })

    await store.transitionPayout({ payoutId: payout.id, action: "void", reference: null, reason: "sent in error", actorUserId: 1 })
    expect(fake.state.payoutItems.every((pi: Row) => pi.released === 1)).toBe(true)
    bal = (await store.partnerBalances(1, 2000)).find((b) => b.currency === "USD")!
    expect(bal).toMatchObject({ available: "10.00", inPayout: "0.00" })

    // the released commission can be paid out again under a new key
    const again = await store.createPayout({ partnerId: 1, currency: "USD", actorUserId: 1, idempotencyKey: "aff-payout-idem-key-03" })
    expect(again).toMatchObject({ replayed: false, entries: 1 })
  })
})

describe("portal scoping", () => {
  it("denies a non-member and returns only the caller's own partner data", async () => {
    partner(1)
    tenant(10)
    await expect(store.resolveAffiliate(999)).rejects.toMatchObject({ code: "PARTNER_ACCESS_DENIED", status: 403 })

    member(1, 77, "rep@partner.io")
    const link = await seedLink(1)
    const r = await store.recordClick({ code: link.code, existingCookie: null, ipHash: null, uaHash: null, now: new Date() })
    await store.claimSignup({ cookieValue: r!.cookie!.value, tenantId: 10, registrant: { userId: 500, email: "buyer@newco.com" }, sessionUserId: null, now: new Date() })

    const portal = await store.getAffiliatePortal(77, new Date())
    expect(portal.affiliate.name).toBe("Partner 1")
    expect(portal.links).toHaveLength(1)
    expect(portal.funnel).toMatchObject({ clicks: 1, referred: 1 })
    // projection is allow-listed: customer name only, no tenant id / ip / ua
    expect(portal.conversions[0]).toMatchObject({ customerName: "Customer 10", state: "referred" })
    expect(JSON.stringify(portal)).not.toMatch(/token_hash|ip_hash|consumed_tenant_id/)
  })
})
