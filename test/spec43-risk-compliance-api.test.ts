import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => ({
  requireTenantAdmin: vi.fn(),
  getUserDomainScope: vi.fn(),
  resolveDataScopeContext: vi.fn(),
  query: vi.fn(),
  audit: vi.fn(),
  compute: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ query: m.query }))
vi.mock("@/lib/platform-guard", () => ({
  requireTenantAdmin: m.requireTenantAdmin,
  effectiveTenantId: (ctx: any) => ctx.tenantId,
}))
vi.mock("@/lib/data-scope-store", () => ({
  getUserDomainScope: m.getUserDomainScope,
  resolveDataScopeContext: m.resolveDataScopeContext,
}))
vi.mock("@/lib/audit-log-store", () => ({ recordAuditLogFromRequest: m.audit }))
// Keep the DB-heavy aggregator out of the route tests; its logic is covered
// separately. isStale mirrors the real impl so cache freshness is exercised.
vi.mock("@/lib/risk-compliance/aggregate", () => ({
  computeRiskComplianceDashboard: m.compute,
  maskDashboard: (d: any) => ({ ...d, masked: true }),
  isStale: (computedAt: string, maxAgeMs: number, now = Date.now()) => {
    const t = new Date(computedAt).getTime()
    return Number.isNaN(t) || now - t > maxAgeMs
  },
}))

import { GET } from "@/app/api/admin/risk-compliance/route"
import { POST as REFRESH } from "@/app/api/admin/risk-compliance/refresh/route"
import { GET as EXPORT, csvCell } from "@/app/api/admin/risk-compliance/export/route"

const OWNER = { ok: true, ctx: { tenantId: 7, tenantRole: "tenant_owner" }, session: { userId: 1, email: "a@x.com", name: "A" } }
const ADMIN = { ok: true, ctx: { tenantId: 7, tenantRole: "tenant_admin" }, session: { userId: 2, email: "b@x.com", name: "B" } }
const DENY_401 = { ok: false, status: 401, reason: "Not authenticated" }
const DENY_403 = { ok: false, status: 403, reason: "Insufficient tenant privileges" }

function dash(over: any = {}) {
  return {
    tenantId: 7,
    scope: { level: "group", value: null },
    scopeKey: "group",
    computedAt: new Date().toISOString(),
    masked: false,
    totals: { openItems: 2, critical: 0, high: 1, sourcesAvailable: 5, sourcesMissing: 1, sourcesWithheld: 0 },
    categories: {},
    sources: [
      {
        key: "payments",
        label: "Payment exceptions",
        category: "finance",
        available: true,
        scopeApplied: false,
        withheld: false,
        count: 1,
        severity: "high",
        asOf: null,
        drillHref: "/modules/finance/payments",
        items: [{ id: "p1", label: "Pay", detail: "Reversed", severity: "high", amount: 100, occurredAt: null, sensitive: { party: "Acme" } }],
      },
    ],
    ...over,
  }
}

const url = (path: string) => `http://localhost${path}`

beforeEach(() => {
  for (const fn of Object.values(m)) (fn as any).mockReset?.()
  m.getUserDomainScope.mockResolvedValue("all")
  m.resolveDataScopeContext.mockResolvedValue({ assignedEntities: [], assignedBranches: [] })
  m.query.mockResolvedValue(undefined)
  m.compute.mockResolvedValue(dash())
})

describe("GET /api/admin/risk-compliance — permission gate", () => {
  it("returns 401 when unauthenticated", async () => {
    m.requireTenantAdmin.mockResolvedValue(DENY_401)
    const res = await GET(new NextRequest(url("/api/admin/risk-compliance")))
    expect(res.status).toBe(401)
    expect(m.compute).not.toHaveBeenCalled()
  })

  it("returns 403 for a non-admin tenant user", async () => {
    m.requireTenantAdmin.mockResolvedValue(DENY_403)
    expect((await GET(new NextRequest(url("/api/admin/risk-compliance")))).status).toBe(403)
  })
})

describe("GET /api/admin/risk-compliance — scope + masking", () => {
  it("masks PII for non-owners and never recomputes with a client tenant id", async () => {
    m.requireTenantAdmin.mockResolvedValue(ADMIN)
    m.query.mockResolvedValue([]) // no cached snapshot
    const res = await GET(new NextRequest(url("/api/admin/risk-compliance?tenantId=999")))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.dashboard.masked).toBe(true)
    expect(body.meta.canViewSensitive).toBe(false)
    // tenant comes from the session guard (7), never the query string.
    expect(m.compute).toHaveBeenCalledWith(7, { level: "group", value: null })
  })

  it("returns unmasked data for a tenant owner", async () => {
    m.requireTenantAdmin.mockResolvedValue(OWNER)
    m.query.mockResolvedValue([])
    const body = await (await GET(new NextRequest(url("/api/admin/risk-compliance")))).json()
    expect(body.dashboard.masked).toBe(false)
    expect(body.meta.canViewSensitive).toBe(true)
  })

  it("enforces the caller's data-scope grant (in-scope company allowed)", async () => {
    m.requireTenantAdmin.mockResolvedValue(ADMIN)
    m.getUserDomainScope.mockResolvedValue("entity")
    m.resolveDataScopeContext.mockResolvedValue({ assignedEntities: ["Acme"], assignedBranches: [] })
    m.query.mockResolvedValue([])
    const res = await GET(new NextRequest(url("/api/admin/risk-compliance?level=company&value=Acme")))
    expect(res.status).toBe(200)
    expect((await res.json()).meta.restricted).toBe(true)
    expect(m.compute).toHaveBeenCalledWith(7, { level: "company", value: "Acme" })
  })

  it("rejects a company outside the caller's grant with 403", async () => {
    m.requireTenantAdmin.mockResolvedValue(ADMIN)
    m.getUserDomainScope.mockResolvedValue("entity")
    m.resolveDataScopeContext.mockResolvedValue({ assignedEntities: ["Acme"], assignedBranches: [] })
    const res = await GET(new NextRequest(url("/api/admin/risk-compliance?level=company&value=Initech")))
    expect(res.status).toBe(403)
    expect(m.compute).not.toHaveBeenCalled()
  })
})

describe("GET /api/admin/risk-compliance — snapshot cache", () => {
  it("serves a fresh same-tenant snapshot without recomputing", async () => {
    m.requireTenantAdmin.mockResolvedValue(OWNER)
    m.query.mockResolvedValue([
      { payload: JSON.stringify({ tenantId: 7, scopeKey: "group", totals: {}, sources: [] }), computed_at: new Date() },
    ])
    const body = await (await GET(new NextRequest(url("/api/admin/risk-compliance")))).json()
    expect(body.meta.fromCache).toBe(true)
    expect(m.compute).not.toHaveBeenCalled()
  })

  it("ignores a cached payload belonging to another tenant (defense in depth)", async () => {
    m.requireTenantAdmin.mockResolvedValue(OWNER)
    m.query.mockResolvedValue([
      { payload: JSON.stringify({ tenantId: 999, scopeKey: "group", totals: {}, sources: [] }), computed_at: new Date() },
    ])
    const body = await (await GET(new NextRequest(url("/api/admin/risk-compliance")))).json()
    expect(body.meta.fromCache).toBe(false)
    expect(m.compute).toHaveBeenCalledTimes(1)
  })

  it("recomputes when the cached snapshot is stale", async () => {
    m.requireTenantAdmin.mockResolvedValue(OWNER)
    const old = new Date(Date.now() - 60 * 60 * 1000) // 1h old > 15m threshold
    m.query.mockResolvedValue([{ payload: JSON.stringify({ tenantId: 7, scopeKey: "group", totals: {}, sources: [] }), computed_at: old }])
    const body = await (await GET(new NextRequest(url("/api/admin/risk-compliance")))).json()
    expect(body.meta.fromCache).toBe(false)
    expect(m.compute).toHaveBeenCalledTimes(1)
  })
})

describe("POST /api/admin/risk-compliance/refresh — idempotency + audit", () => {
  const post = (body: any, headers: Record<string, string> = {}) =>
    REFRESH(
      new NextRequest(url("/api/admin/risk-compliance/refresh"), {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    )

  it("403 for a non-admin", async () => {
    m.requireTenantAdmin.mockResolvedValue(DENY_403)
    expect((await post({ level: "group" })).status).toBe(403)
  })

  it("rejects a malformed Idempotency-Key with 400", async () => {
    m.requireTenantAdmin.mockResolvedValue(OWNER)
    expect((await post({ level: "group" }, { "idempotency-key": "bad key!" })).status).toBe(400)
  })

  it("computes, inserts and audits a fresh refresh", async () => {
    m.requireTenantAdmin.mockResolvedValue(OWNER)
    m.query.mockImplementation(async (sql: string) => (sql.includes("SELECT scope_key, payload") ? [] : undefined))
    const res = await post({ level: "group" }, { "idempotency-key": "key-12345678" })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.replayed).toBe(false)
    expect(m.compute).toHaveBeenCalledTimes(1)
    expect(m.query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT"))).toBe(true)
    expect(m.audit).toHaveBeenCalledTimes(1)
  })

  it("replays a stored snapshot for a repeated key without recomputing or re-auditing", async () => {
    m.requireTenantAdmin.mockResolvedValue(OWNER)
    m.query.mockImplementation(async (sql: string) =>
      sql.includes("SELECT scope_key, payload") ? [{ scope_key: "group", payload: JSON.stringify(dash()) }] : undefined,
    )
    const res = await post({ level: "group" }, { "idempotency-key": "key-12345678" })
    const body = await res.json()
    expect(body.replayed).toBe(true)
    expect(m.compute).not.toHaveBeenCalled()
    expect(m.audit).not.toHaveBeenCalled()
    expect(m.query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT"))).toBe(false)
  })

  it("409 when the same key is reused for a different scope", async () => {
    m.requireTenantAdmin.mockResolvedValue(OWNER)
    m.query.mockImplementation(async (sql: string) =>
      sql.includes("SELECT scope_key, payload") ? [{ scope_key: "company:Acme", payload: "{}" }] : undefined,
    )
    expect((await post({ level: "group" }, { "idempotency-key": "key-12345678" })).status).toBe(409)
  })

  it("masks the replayed snapshot for a non-owner admin", async () => {
    m.requireTenantAdmin.mockResolvedValue(ADMIN)
    m.query.mockImplementation(async (sql: string) =>
      sql.includes("SELECT scope_key, payload") ? [{ scope_key: "group", payload: JSON.stringify(dash()) }] : undefined,
    )
    const body = await (await post({ level: "group" }, { "idempotency-key": "key-12345678" })).json()
    expect(body.dashboard.masked).toBe(true)
  })
})

describe("GET /api/admin/risk-compliance/export — masking + audit", () => {
  it("masks and records unmasked=false for a non-owner", async () => {
    m.requireTenantAdmin.mockResolvedValue(ADMIN)
    const res = await EXPORT(new NextRequest(url("/api/admin/risk-compliance/export?unmasked=1")))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/text\/csv/)
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ metadata: expect.objectContaining({ unmasked: false }) }))
  })

  it("allows a tenant owner to export unmasked with unmasked=1", async () => {
    m.requireTenantAdmin.mockResolvedValue(OWNER)
    await EXPORT(new NextRequest(url("/api/admin/risk-compliance/export?unmasked=1")))
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ metadata: expect.objectContaining({ unmasked: true }) }))
  })

  it("keeps an owner masked unless they explicitly opt in", async () => {
    m.requireTenantAdmin.mockResolvedValue(OWNER)
    await EXPORT(new NextRequest(url("/api/admin/risk-compliance/export")))
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ metadata: expect.objectContaining({ unmasked: false }) }))
  })
})

describe("csvCell — spreadsheet formula-injection safety", () => {
  it("neutralises leading formula characters and escapes quotes", () => {
    expect(csvCell("=cmd()")).toBe("\"'=cmd()\"")
    expect(csvCell("+1")).toBe("\"'+1\"")
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell(null)).toBe('""')
  })
})
