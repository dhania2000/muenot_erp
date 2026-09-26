import { beforeEach, describe, expect, it, vi } from "vitest"

type Row = Record<string, any>
const state = vi.hoisted(() => ({
  tenant: null as number | null,
  boundTenants: [] as number[],
  leads: [] as Row[],
  waLinks: [] as Row[],
}))
const mocks = vi.hoisted(() => ({ recordActivitySafe: vi.fn(), query: vi.fn() }))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: mocks.query }))
vi.mock("@/lib/activity/db", () => ({ recordActivitySafe: mocks.recordActivitySafe }))
vi.mock("@/lib/tenant-scope", () => ({
  currentTenantIdOrNull: () => state.tenant,
  runForTenant: async (ctx: { tenantId: number }, fn: () => any) => {
    state.boundTenants.push(ctx.tenantId)
    const prev = state.tenant
    state.tenant = ctx.tenantId
    try {
      return await fn()
    } finally {
      state.tenant = prev
    }
  },
}))

import { mirrorLeadCommunication, mirrorWhatsAppMessage, resolveLeadForTimeline } from "@/lib/collaboration/crm-timeline"

function handle(sql: string, p: any[]): Row[] {
  const s = sql.replace(/\s+/g, " ")
  if (/FROM sales_leads WHERE tenant_id = \? AND id = \?/.test(s)) return state.leads.filter((l) => l.tenant_id === p[0] && l.id === p[1])
  if (/FROM sales_leads WHERE id = \?/.test(s)) return state.leads.filter((l) => l.id === p[0])
  if (/FROM marketing_whatsapp_conversations cv/.test(s)) {
    expect(s).toMatch(/ct.tenant_id = cv.tenant_id/)
    expect(s).toMatch(/l.tenant_id = cv.tenant_id/)
    return state.waLinks.filter((w) => w.tenant_id === p[0] && w.conversation_id === p[1])
  }
  throw new Error(`unexpected SQL: ${s}`)
}

beforeEach(() => {
  state.tenant = 1
  state.boundTenants = []
  state.leads = [
    { id: 10, tenant_id: 1, company_name: "Acme" },
    { id: 20, tenant_id: 2, company_name: "Globex" },
    { id: 30, tenant_id: null, company_name: "Orphan" },
  ]
  state.waLinks = [{ tenant_id: 1, conversation_id: 5, id: 10, company_name: "Acme" }]
  mocks.query.mockReset().mockImplementation(async (sql: string, p: any[] = []) => handle(sql, p))
  mocks.recordActivitySafe.mockReset().mockImplementation(async () => ({ id: 1, activity_code: "ACT-1" }))
})

describe("resolveLeadForTimeline — tenant isolation", () => {
  it("resolves a lead in the acting tenant", async () => {
    expect(await resolveLeadForTimeline(10)).toEqual({ tenantId: 1, id: 10, label: "Acme" })
  })
  it("returns null for another tenant's lead id (no cross-tenant write target)", async () => {
    expect(await resolveLeadForTimeline(20)).toBeNull()
  })
  it("derives the owning tenant in system context (scheduler)", async () => {
    state.tenant = null
    expect(await resolveLeadForTimeline(20)).toEqual({ tenantId: 2, id: 20, label: "Globex" })
  })
  it("rejects leads without an owning tenant and invalid ids", async () => {
    state.tenant = null
    expect(await resolveLeadForTimeline(30)).toBeNull()
    expect(await resolveLeadForTimeline(0)).toBeNull()
    expect(await resolveLeadForTimeline(Number.NaN)).toBeNull()
    expect(mocks.query).toHaveBeenCalledTimes(1)
  })
})

describe("mirrorLeadCommunication", () => {
  it("writes into the unified stream bound to the lead's tenant with a dedupe key", async () => {
    state.tenant = null
    await mirrorLeadCommunication({ tenantId: 2, id: 20, label: "Globex" }, {
      channel: "email",
      title: "Proposal sent",
      body: "x".repeat(20000),
      refType: "sales_email",
      refId: 77,
      actorId: 4,
    })
    expect(state.boundTenants).toEqual([2])
    const [input, opts] = mocks.recordActivitySafe.mock.calls[0]
    expect(input).toMatchObject({ kind: "email", subject_type: "lead", subject_id: 20, source_module: "crm", action: "outbound", actor_id: 4 })
    expect(input.body).toHaveLength(10000)
    expect(opts?.dedupeKey).toBeTruthy()
  })

  it("maps notes and meetings to internal direction", async () => {
    const lead = { tenantId: 1, id: 10, label: "Acme" }
    await mirrorLeadCommunication(lead, { channel: "note", title: "Called back" })
    await mirrorLeadCommunication(lead, { channel: "meeting", title: "Demo" })
    expect(mocks.recordActivitySafe.mock.calls[0][0]).toMatchObject({ action: "noted", meta: { direction: "internal" } })
    expect(mocks.recordActivitySafe.mock.calls[1][0]).toMatchObject({ action: "internal" })
  })

  it("uses the same dedupe key for a repeated source reference (idempotent retries)", async () => {
    const lead = { tenantId: 1, id: 10, label: "Acme" }
    await mirrorLeadCommunication(lead, { channel: "call", title: "Call", refType: "sales_call", refId: 9 })
    await mirrorLeadCommunication(lead, { channel: "call", title: "Call again", refType: "sales_call", refId: 9 })
    const [a, b] = mocks.recordActivitySafe.mock.calls.map((c) => c[1]?.dedupeKey)
    expect(a).toBe(b)
  })
})

describe("mirrorWhatsAppMessage", () => {
  it("posts inbound messages to the linked lead, keyed by wamid", async () => {
    await mirrorWhatsAppMessage({ conversationId: 5, direction: "inbound", wamid: "wamid.ABC", messageType: "text", body: "Hi" })
    const [input, opts] = mocks.recordActivitySafe.mock.calls[0]
    expect(input).toMatchObject({ kind: "whatsapp", subject_id: 10, action: "inbound", ref_id: "wamid.ABC", actor_id: null })
    expect(opts?.dedupeKey).toContain("wamid.ABC")
  })

  it("labels media messages without a text body", async () => {
    await mirrorWhatsAppMessage({ conversationId: 5, direction: "outbound", wamid: null, messageId: 42, messageType: "image", body: null, actorId: 3 })
    expect(mocks.recordActivitySafe.mock.calls[0][0]).toMatchObject({ body: "[image]", ref_id: "msg-42", actor_id: 3 })
  })

  it("skips conversations not linked to a lead, or from another tenant", async () => {
    expect(await mirrorWhatsAppMessage({ conversationId: 99, direction: "inbound", wamid: "w", messageType: "text", body: "x" })).toBeNull()
    state.tenant = 2
    expect(await mirrorWhatsAppMessage({ conversationId: 5, direction: "inbound", wamid: "w", messageType: "text", body: "x" })).toBeNull()
    expect(mocks.recordActivitySafe).not.toHaveBeenCalled()
  })

  it("does nothing without a tenant in context", async () => {
    state.tenant = null
    expect(await mirrorWhatsAppMessage({ conversationId: 5, direction: "inbound", wamid: "w", messageType: "text", body: "x" })).toBeNull()
    expect(mocks.query).not.toHaveBeenCalled()
  })
})
