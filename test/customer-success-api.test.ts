import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  session: vi.fn(),
  tenantAdmin: vi.fn(),
  platformStaff: vi.fn(),
  audit: vi.fn(),
  platformAudit: vi.fn(),
  record: vi.fn(),
  health: vi.fn(),
  list: vi.fn(),
  exists: vi.fn(),
  snapshot: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  isUserOptedOut: vi.fn(),
  setUserOptOut: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({ getSession: m.session }))
vi.mock("@/lib/platform-guard", () => ({
  requireTenantAdmin: m.tenantAdmin,
  requirePlatformStaff: m.platformStaff,
  effectiveTenantId: (ctx: { tenantId: number }) => ctx.tenantId,
}))
vi.mock("@/lib/audit-log-store", () => ({ recordAuditLogFromRequest: m.audit }))
vi.mock("@/lib/platform-roles", () => ({ recordPlatformAudit: m.platformAudit }))
vi.mock("@/lib/customer-success/store", () => ({
  recordUsageEvents: m.record,
  getTenantHealth: m.health,
  listTenantHealth: m.list,
  tenantExists: m.exists,
  computeSnapshot: m.snapshot,
  getSettings: m.getSettings,
  updateSettings: m.updateSettings,
  isUserOptedOut: m.isUserOptedOut,
  setUserOptOut: m.setUserOptOut,
}))

import * as events from "@/app/api/analytics/events/route"
import * as optOut from "@/app/api/analytics/opt-out/route"
import * as adminHealth from "@/app/api/admin/customer-success/route"
import * as adminSettings from "@/app/api/admin/customer-success/settings/route"
import * as platformList from "@/app/api/platform/customer-success/route"
import * as platformTenant from "@/app/api/platform/customer-success/[tenantId]/route"

const json = (url: string, body: unknown, method = "POST") =>
  new Request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
const ctx = (tenantId: string) => ({ params: Promise.resolve({ tenantId }) })
const adminOk = (tenantId = 7) => ({ ok: true, ctx: { tenantId }, session: { userId: 5 } })
const staffOk = { ok: true, session: { userId: 1, email: "ops@muenot.test" } }
const denied = { ok: false, status: 403, reason: "Forbidden" }

beforeEach(() => {
  vi.resetAllMocks()
  m.session.mockResolvedValue({ userId: 5, tenantId: 7, role: "employee" })
  m.record.mockResolvedValue({ accepted: 1, duplicates: 0, dropped: 0, reason: null })
})

describe("POST /api/analytics/events", () => {
  it("requires a session and a tenant", async () => {
    m.session.mockResolvedValue(null)
    expect((await events.POST(json("http://x/api/analytics/events", { events: [] }))).status).toBe(401)
    m.session.mockResolvedValue({ userId: 5, tenantId: null })
    expect((await events.POST(json("http://x/api/analytics/events", { events: [] }))).status).toBe(403)
  })
  it("uses the session tenant, ignoring any tenantId or userId in the body", async () => {
    const res = await events.POST(json("http://x/api/analytics/events", { tenantId: 99, userId: 1, events: [{ module: "sales", feature: "leads", tenantId: 99 }] }))
    expect(res.status).toBe(202)
    const arg = m.record.mock.calls[0][0]
    expect(arg.tenantId).toBe(7)
    expect(arg.userId).toBe(5)
    expect(Object.keys(arg.events[0]).sort()).toEqual(["action", "clientEventId", "feature", "module", "occurredAt"])
  })
  it("rejects invalid events with 400 and does not persist", async () => {
    const res = await events.POST(json("http://x/api/analytics/events", { events: [{ module: "Has Spaces", feature: "x" }] }))
    expect(res.status).toBe(400)
    expect(m.record).not.toHaveBeenCalled()
  })
  it("never counts impersonated platform sessions", async () => {
    m.session.mockResolvedValue({ userId: 1, tenantId: 7, impersonatedTenantId: 7 })
    const res = await events.POST(json("http://x/api/analytics/events", { events: [{ module: "sales", feature: "leads" }] }))
    expect(await res.json()).toMatchObject({ accepted: 0, reason: "impersonation" })
    expect(m.record).not.toHaveBeenCalled()
  })
  it("returns a sanitized 500 on store failure", async () => {
    m.record.mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1:3306"))
    const res = await events.POST(json("http://x/api/analytics/events", { events: [{ module: "sales", feature: "leads" }] }))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("10.0.0.1")
  })
})

describe("PUT /api/analytics/opt-out", () => {
  it("only affects the caller and audits changes", async () => {
    m.setUserOptOut.mockResolvedValue({ changed: true, purgedEvents: 3 })
    const res = await optOut.PUT(json("http://x", { optOut: true, userId: 99 }, "PUT"))
    expect(res.status).toBe(200)
    expect(m.setUserOptOut).toHaveBeenCalledWith(7, 5, true)
    expect(m.audit).toHaveBeenCalledTimes(1)
  })
  it("is idempotent: no audit when nothing changed", async () => {
    m.setUserOptOut.mockResolvedValue({ changed: false, purgedEvents: 0 })
    await optOut.PUT(json("http://x", { optOut: true }, "PUT"))
    expect(m.audit).not.toHaveBeenCalled()
  })
  it("validates body", async () => {
    expect((await optOut.PUT(json("http://x", { optOut: "yes" }, "PUT"))).status).toBe(400)
    expect(m.setUserOptOut).not.toHaveBeenCalled()
  })
})

describe("tenant admin endpoints", () => {
  it("deny non-admins", async () => {
    m.tenantAdmin.mockResolvedValue(denied)
    expect((await adminHealth.GET()).status).toBe(403)
    expect((await adminSettings.PUT(json("http://x", { analyticsOptOut: true }, "PUT"))).status).toBe(403)
    expect(m.health).not.toHaveBeenCalled()
    expect(m.updateSettings).not.toHaveBeenCalled()
  })
  it("scope health to the admin's own tenant (cross-tenant ignored)", async () => {
    m.tenantAdmin.mockResolvedValue(adminOk(7))
    m.health.mockResolvedValue({ snapshot: { score: 80 } })
    const res = await adminHealth.GET()
    expect(res.status).toBe(200)
    expect(m.health).toHaveBeenCalledWith(7)
  })
  it("settings update targets own tenant, audits only on change", async () => {
    m.tenantAdmin.mockResolvedValue(adminOk(7))
    m.updateSettings.mockResolvedValue({ before: {}, settings: { analyticsOptOut: true, retentionDays: 180 }, changed: true, purgedEvents: 10 })
    const res = await adminSettings.PUT(json("http://x", { analyticsOptOut: true, tenantId: 99 }, "PUT"))
    expect(res.status).toBe(200)
    expect(m.updateSettings).toHaveBeenCalledWith(7, { analyticsOptOut: true }, 5)
    expect(m.audit).toHaveBeenCalledTimes(1)
    m.updateSettings.mockResolvedValue({ before: {}, settings: {}, changed: false, purgedEvents: 0 })
    await adminSettings.PUT(json("http://x", { analyticsOptOut: true }, "PUT"))
    expect(m.audit).toHaveBeenCalledTimes(1)
  })
  it("rejects invalid retention", async () => {
    m.tenantAdmin.mockResolvedValue(adminOk(7))
    expect((await adminSettings.PUT(json("http://x", { retentionDays: 5 }, "PUT"))).status).toBe(400)
  })
})

describe("platform endpoints", () => {
  it("deny tenant users", async () => {
    m.platformStaff.mockResolvedValue(denied)
    expect((await platformList.GET(new Request("http://x/api/platform/customer-success"))).status).toBe(403)
    expect((await platformTenant.GET(new Request("http://x"), ctx("7"))).status).toBe(403)
    expect((await platformTenant.POST(new Request("http://x", { method: "POST" }), ctx("7"))).status).toBe(403)
    expect(m.list).not.toHaveBeenCalled()
    expect(m.snapshot).not.toHaveBeenCalled()
  })
  it("list applies validated filters", async () => {
    m.platformStaff.mockResolvedValue(staffOk)
    m.list.mockResolvedValue({ rows: [], total: 0 })
    const res = await platformList.GET(new Request("http://x/api/platform/customer-success?band=watch&risk=1"))
    expect(res.status).toBe(200)
    expect(m.list).toHaveBeenCalledWith(expect.objectContaining({ band: "watch", atRiskOnly: true }))
    expect((await platformList.GET(new Request("http://x/api/platform/customer-success?band=nope"))).status).toBe(400)
  })
  it("validates tenant id and 404s unknown tenants", async () => {
    m.platformStaff.mockResolvedValue(staffOk)
    expect((await platformTenant.GET(new Request("http://x"), ctx("1 OR 1=1"))).status).toBe(400)
    m.exists.mockResolvedValue(false)
    expect((await platformTenant.GET(new Request("http://x"), ctx("123"))).status).toBe(404)
  })
  it("recompute is audited", async () => {
    m.platformStaff.mockResolvedValue(staffOk)
    m.exists.mockResolvedValue(true)
    m.snapshot.mockResolvedValue({ score: 60, band: "watch", date: "2026-09-26" })
    const res = await platformTenant.POST(new Request("http://x", { method: "POST" }), ctx("7"))
    expect(res.status).toBe(200)
    expect(m.snapshot).toHaveBeenCalledWith(7)
    expect(m.platformAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "customer_success_recomputed", targetTenantId: 7 }))
  })
})
