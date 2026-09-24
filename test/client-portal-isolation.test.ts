import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { SignJWT } from "jose"

/**
 * SPEC 118 — Client Portal · Phase 4: tenant / CLIENT isolation.
 * ---------------------------------------------------------------------------
 * The portal isolates data on TWO axes that must BOTH hold on every access:
 *
 *   1. tenant_id  — enforced globally by the data-layer guard.
 *   2. client_id  — enforced by the portal store; this is what stops one
 *      client from reading another client's rows INSIDE the same tenant.
 *
 * Both `tenantId` and `clientId` must originate from the verified portal
 * session, never from portal-user input. These tests mock the DB layer to
 * capture the exact SQL + params each helper emits and prove that:
 *   - every read/write is constrained by BOTH tenant_id AND client_id,
 *   - a forged id cannot reach another client's row (IDOR),
 *   - portal session tokens are domain-separated from internal tokens,
 *   - resource access is fail-closed.
 */

// Capture every statement the helpers would run instead of hitting MySQL.
const calls: { sql: string; params: any[] }[] = []
let results: any[] = []

vi.mock("@/lib/db", () => ({
  query: vi.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params })
    return results.length ? results.shift() : []
  }),
}))

// The runtime schema self-heal is irrelevant to isolation; keep it out of the
// captured statements so assertions read cleanly.
vi.mock("@/lib/portal/schema", () => ({
  ensurePortalSchema: vi.fn(async () => {}),
}))

// Password verification is controlled per-test.
const passwordMock = vi.hoisted(() => ({ verify: vi.fn(async () => true) }))
vi.mock("@/lib/password", () => ({
  hashPassword: vi.fn(async (p: string) => `hash:${p}`),
  verifyPassword: passwordMock.verify,
}))

import { PORTAL_RESOURCES, isPortalResource, isPortalItemResource } from "@/lib/portal/config"
import { resolveGrantedResources } from "@/lib/portal/access"
import {
  createPortalSessionToken,
  verifyPortalSessionToken,
  type PortalSessionPayload,
} from "@/lib/portal/auth"
import {
  addTicketMessage,
  authenticatePortalUser,
  countItemsByResource,
  createMessage,
  createTicket,
  getTicket,
  listItems,
  listMessages,
  listTickets,
} from "@/lib/portal/store"

const TENANT = 7
const CLIENT = 42
const OTHER_CLIENT = 99

/** Params that carry both the tenant AND the client scope. */
function scopedByTenantAndClient(params: any[]): boolean {
  return params.includes(TENANT) && params.includes(CLIENT)
}

beforeAll(() => {
  process.env.SESSION_SECRET = "test-portal-secret"
})

beforeEach(() => {
  calls.length = 0
  results = []
  passwordMock.verify.mockResolvedValue(true)
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// SPEC coverage: every resource the spec lists is representable.
// ---------------------------------------------------------------------------
describe("resource coverage (SPEC 118)", () => {
  it("exposes exactly the eight permitted resources", () => {
    expect([...PORTAL_RESOURCES].sort()).toEqual(
      ["documents", "invoices", "messages", "orders", "payments", "projects", "quotes", "tickets"].sort(),
    )
  })

  it("recognizes valid resources and rejects unknown ones", () => {
    expect(isPortalResource("invoices")).toBe(true)
    expect(isPortalResource("payroll")).toBe(false)
    // Tickets/messages are interactive, not read-only shared "items".
    expect(isPortalItemResource("quotes")).toBe(true)
    expect(isPortalItemResource("tickets")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Access control is fail-closed.
// ---------------------------------------------------------------------------
describe("resource access (fail-closed)", () => {
  it("grants only resources that are both valid and enabled", () => {
    const granted = resolveGrantedResources([
      { resource: "invoices", enabled: 1 },
      { resource: "orders", enabled: 0 }, // explicitly disabled
      { resource: "payroll", enabled: 1 }, // not a real portal resource
    ])
    expect(granted).toEqual(["invoices"])
  })

  it("returns nothing when there are no grants", () => {
    expect(resolveGrantedResources([])).toEqual([])
  })

  it("preserves canonical resource ordering regardless of input order", () => {
    const granted = resolveGrantedResources([
      { resource: "messages", enabled: true },
      { resource: "quotes", enabled: true },
    ])
    expect(granted).toEqual(["quotes", "messages"])
  })
})

// ---------------------------------------------------------------------------
// Session tokens are domain-separated from the internal app.
// ---------------------------------------------------------------------------
describe("portal session tokens", () => {
  const payload: Omit<PortalSessionPayload, "typ"> = {
    portalUserId: 1,
    tenantId: TENANT,
    clientId: CLIENT,
    email: "client@example.com",
    name: "Client User",
  }

  it("round-trips a portal token and preserves the tenant + client scope", async () => {
    const token = await createPortalSessionToken(payload)
    const verified = await verifyPortalSessionToken(token)
    expect(verified).toMatchObject({ typ: "portal", tenantId: TENANT, clientId: CLIENT })
  })

  it("rejects a token signed with the internal (non-portal) key", async () => {
    // An internal token uses the base secret WITHOUT the ":portal" suffix.
    const internalKey = new TextEncoder().encode(process.env.SESSION_SECRET!)
    const foreign = await new SignJWT({ ...payload, typ: "session" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(internalKey)
    expect(await verifyPortalSessionToken(foreign)).toBeNull()
  })

  it("rejects a correctly-signed token that lacks the portal typ claim", async () => {
    const portalKey = new TextEncoder().encode(`${process.env.SESSION_SECRET}:portal`)
    const noTyp = await new SignJWT({ ...payload })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(portalKey)
    expect(await verifyPortalSessionToken(noTyp)).toBeNull()
  })

  it("rejects a tampered token", async () => {
    const token = await createPortalSessionToken(payload)
    expect(await verifyPortalSessionToken(`${token}x`)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Store reads: every query is scoped by BOTH tenant_id AND client_id.
// ---------------------------------------------------------------------------
describe("store reads (tenant + client scoping)", () => {
  it("scopes shared-item reads to the tenant and client", async () => {
    await listItems(TENANT, CLIENT, "invoices")
    expect(calls[0].sql).toContain("tenant_id = ?")
    expect(calls[0].sql).toContain("client_id = ?")
    expect(calls[0].params).toEqual([TENANT, CLIENT, "invoices"])
  })

  it("scopes item counts to the tenant and client", async () => {
    results = [[{ resource: "invoices", n: 3 }]]
    const counts = await countItemsByResource(TENANT, CLIENT)
    expect(calls[0].params).toEqual([TENANT, CLIENT])
    expect(counts).toEqual({ invoices: 3 })
  })

  it("scopes ticket lists to the tenant and client", async () => {
    await listTickets(TENANT, CLIENT)
    expect(scopedByTenantAndClient(calls[0].params)).toBe(true)
  })

  it("scopes message threads to the tenant and client", async () => {
    await listMessages(TENANT, CLIENT)
    expect(scopedByTenantAndClient(calls[0].params)).toBe(true)
  })

  it("returns null for a ticket that belongs to another client (IDOR defense)", async () => {
    results = [[]] // the scoped SELECT finds nothing for this (tenant, client)
    const ticket = await getTicket(TENANT, CLIENT, 12345)
    expect(ticket).toBeNull()
    // The ownership check ran with all three scope params.
    expect(calls[0].params).toEqual([TENANT, CLIENT, 12345])
    // And it never went on to read the messages of a foreign ticket.
    expect(calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Store writes: the acting tenant + client are stamped, not taken from input.
// ---------------------------------------------------------------------------
describe("store writes (tenant + client stamping)", () => {
  it("stamps tenant + client on a new ticket and its first message", async () => {
    results = [
      [{ n: 0 }], // nextTicketNumber COUNT
      { insertId: 10 }, // INSERT ticket
      { insertId: 20 }, // INSERT first message
      [{ id: 10, ticket_number: "TKT-00001", subject: "Help", priority: "normal", status: "open" }],
      [], // messages
    ]
    await createTicket({
      tenantId: TENANT,
      clientId: CLIENT,
      portalUserId: 1,
      authorName: "Client User",
      subject: "Help",
      body: "Please assist",
    })
    const ticketInsert = calls.find((c) => c.sql.includes("INSERT INTO client_portal_tickets"))!
    const messageInsert = calls.find((c) => c.sql.includes("INSERT INTO client_portal_ticket_messages"))!
    expect(scopedByTenantAndClient(ticketInsert.params)).toBe(true)
    expect(scopedByTenantAndClient(messageInsert.params)).toBe(true)
  })

  it("refuses to append a message to a ticket owned by another client (IDOR defense)", async () => {
    results = [[]] // ownership SELECT finds no matching (tenant, client, ticket)
    const res = await addTicketMessage({
      tenantId: TENANT,
      clientId: OTHER_CLIENT,
      ticketId: 10,
      authorName: "Attacker",
      body: "let me in",
    })
    expect(res).toBeNull()
    // Only the ownership check ran; no INSERT was emitted.
    expect(calls).toHaveLength(1)
    expect(calls.some((c) => c.sql.includes("INSERT"))).toBe(false)
  })

  it("stamps tenant + client + author as 'client' on a new message", async () => {
    results = [{ insertId: 5 }]
    const msg = await createMessage({
      tenantId: TENANT,
      clientId: CLIENT,
      portalUserId: 1,
      authorName: "Client User",
      body: "hello",
    })
    expect(scopedByTenantAndClient(calls[0].params)).toBe(true)
    expect(msg.author_type).toBe("client")
  })
})

// ---------------------------------------------------------------------------
// Authentication derives tenant + client from the account, never from input.
// ---------------------------------------------------------------------------
describe("authentication (session scope comes from the account)", () => {
  it("returns the account's own tenant + client on success", async () => {
    results = [
      [
        {
          id: 1,
          tenant_id: TENANT,
          client_id: CLIENT,
          email: "client@example.com",
          name: "Client User",
          status: "active",
          must_change_password: 0,
          last_login_at: null,
          password_hash: "hash:pw",
          locked_until: null,
          failed_attempts: 0,
        },
      ],
      { affectedRows: 1 }, // login bookkeeping UPDATE
    ]
    passwordMock.verify.mockResolvedValueOnce(true)
    const res = await authenticatePortalUser("client@example.com", "pw")
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.user.tenant_id).toBe(TENANT)
      expect(res.user.client_id).toBe(CLIENT)
    }
    // The login bookkeeping UPDATE is tenant-scoped.
    const update = calls.find((c) => c.sql.includes("UPDATE client_portal_users"))!
    expect(update.params).toContain(TENANT)
  })

  it("rejects a wrong password and increments the tenant-scoped lockout counter", async () => {
    results = [
      [
        {
          id: 1,
          tenant_id: TENANT,
          client_id: CLIENT,
          email: "client@example.com",
          name: "Client User",
          status: "active",
          must_change_password: 0,
          last_login_at: null,
          password_hash: "hash:pw",
          locked_until: null,
          failed_attempts: 0,
        },
      ],
      { affectedRows: 1 }, // failed-attempt UPDATE
    ]
    passwordMock.verify.mockResolvedValueOnce(false)
    const res = await authenticatePortalUser("client@example.com", "wrong")
    expect(res).toEqual({ ok: false, reason: "invalid" })
    const update = calls.find(
      (c) => c.sql.includes("UPDATE client_portal_users") && c.sql.includes("failed_attempts = failed_attempts + 1"),
    )!
    expect(update.params).toContain(TENANT)
  })

  it("refuses login while the account is locked", async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    results = [
      [
        {
          id: 1,
          tenant_id: TENANT,
          client_id: CLIENT,
          email: "client@example.com",
          name: "Client User",
          status: "active",
          must_change_password: 0,
          last_login_at: null,
          password_hash: "hash:pw",
          locked_until: future,
          failed_attempts: 10,
        },
      ],
    ]
    const res = await authenticatePortalUser("client@example.com", "pw")
    expect(res).toEqual({ ok: false, reason: "locked" })
  })
})
