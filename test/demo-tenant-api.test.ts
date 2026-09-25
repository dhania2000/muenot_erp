import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => {
  class DemoTenantError extends Error {
    status: number
    constructor(message: string, status = 400) {
      super(message)
      this.status = status
    }
  }
  return {
    DemoTenantError,
    staff: vi.fn(),
    superAdmin: vi.fn(),
    list: vi.fn(),
    clone: vi.fn(),
    ensureTemplate: vi.fn(),
    cleanupAll: vi.fn(),
    reset: vi.fn(),
    extend: vi.fn(),
    expire: vi.fn(),
    cleanupOne: vi.fn(),
  }
})

vi.mock("server-only", () => ({}))
vi.mock("@/lib/platform-guard", () => ({ requirePlatformStaff: m.staff, requirePlatformSuperAdmin: m.superAdmin }))
vi.mock("@/lib/demo-tenant-store", () => ({
  DemoTenantError: m.DemoTenantError,
  listDemoTenants: m.list,
  cloneDemoTenant: m.clone,
  ensureDemoTemplate: m.ensureTemplate,
  cleanupExpiredDemoTenants: m.cleanupAll,
  resetDemoTenant: m.reset,
  extendDemoTenant: m.extend,
  forceExpireDemoTenant: m.expire,
  cleanupDemoTenant: m.cleanupOne,
}))

import * as listRoute from "@/app/api/platform/demo-tenants/route"
import * as itemRoute from "@/app/api/platform/demo-tenants/[id]/route"
import * as cronRoute from "@/app/api/cron/demo-tenant-cleanup/route"

const allowed = { ok: true, ctx: { userId: 7 }, session: { email: "root@muenot.test" } }
const denied = { ok: false, status: 403, reason: "Platform super admin only" }
const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://t.test/api/platform/demo-tenants", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }) as any
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.resetAllMocks()
  m.staff.mockResolvedValue(allowed)
  m.superAdmin.mockResolvedValue(allowed)
})

describe("permissions (platform axis only)", () => {
  it("denies tenant admins / non-super-admins every mutating action without touching the store", async () => {
    m.superAdmin.mockResolvedValue(denied)
    expect((await listRoute.POST(req("POST", { action: "clone" }))).status).toBe(403)
    expect((await listRoute.POST(req("POST", { action: "cleanup" }))).status).toBe(403)
    expect((await itemRoute.POST(req("POST", { action: "reset" }), params("1"))).status).toBe(403)
    expect((await itemRoute.DELETE(req("DELETE"), params("1"))).status).toBe(403)
    for (const fn of [m.clone, m.cleanupAll, m.reset, m.cleanupOne]) expect(fn).not.toHaveBeenCalled()
  })

  it("denies listing to non-staff and allows it to staff", async () => {
    m.staff.mockResolvedValueOnce({ ok: false, status: 401, reason: "Sign in" })
    expect((await listRoute.GET()).status).toBe(401)
    m.list.mockResolvedValue([{ id: 1 }])
    const res = await listRoute.GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ demoTenants: [{ id: 1 }] })
  })
})

describe("clone endpoint", () => {
  it("passes the acting operator and the Idempotency-Key header; 201 on create, 200 on replay", async () => {
    m.clone.mockResolvedValueOnce({ replayed: false, tenantId: 50 })
    const created = await listRoute.POST(req("POST", { action: "clone", label: "L", ttlDays: 3 }, { "idempotency-key": "k1" }))
    expect(created.status).toBe(201)
    expect(m.clone).toHaveBeenCalledWith({ userId: 7, email: "root@muenot.test" }, expect.objectContaining({ label: "L" }), "k1")

    m.clone.mockResolvedValueOnce({ replayed: true, tenantId: 50, adminTempPassword: null })
    expect((await listRoute.POST(req("POST", { action: "clone" }, { "idempotency-key": "k1" }))).status).toBe(200)
  })

  it("ignores a body-supplied actor / tenant id", async () => {
    m.clone.mockResolvedValue({ replayed: false })
    await listRoute.POST(req("POST", { action: "clone", userId: 999, tenantId: 1 }))
    expect(m.clone.mock.calls[0][0]).toEqual({ userId: 7, email: "root@muenot.test" })
  })

  it("rejects non-JSON bodies and unknown actions", async () => {
    expect((await listRoute.POST(req("POST", "not json"))).status).toBe(400)
    expect((await listRoute.POST(req("POST", { action: "drop_everything" }))).status).toBe(400)
  })

  it("maps store errors to their status and hides nothing else", async () => {
    m.clone.mockRejectedValue(new m.DemoTenantError("At most 50 active demo tenants", 429))
    const res = await listRoute.POST(req("POST", { action: "clone" }))
    expect(res.status).toBe(429)
    m.clone.mockRejectedValue(new Error("boom"))
    expect((await listRoute.POST(req("POST", { action: "clone" }))).status).toBe(500)
  })
})

describe("single demo lifecycle endpoint", () => {
  it("validates the id before calling the store", async () => {
    for (const id of ["abc", "0", "-1", "1.5", "99999999999999999999"]) {
      expect((await itemRoute.POST(req("POST", { action: "reset" }), params(id))).status).toBe(400)
      expect((await itemRoute.DELETE(req("DELETE"), params(id))).status).toBe(400)
    }
    expect(m.reset).not.toHaveBeenCalled()
    expect(m.cleanupOne).not.toHaveBeenCalled()
  })

  it("routes reset (strict boolean rotate), extend, expire and delete", async () => {
    m.reset.mockResolvedValue({ demo: { id: 3 }, adminTempPassword: null })
    await itemRoute.POST(req("POST", { action: "reset", rotateCredentials: "true" }), params("3"))
    expect(m.reset).toHaveBeenCalledWith(expect.anything(), 3, { rotateCredentials: false })

    m.extend.mockResolvedValue({ id: 3 })
    await itemRoute.POST(req("POST", { action: "extend", days: 5 }), params("3"))
    expect(m.extend).toHaveBeenCalledWith(expect.anything(), 3, 5)

    m.expire.mockResolvedValue({ id: 3 })
    expect((await itemRoute.POST(req("POST", { action: "expire" }), params("3"))).status).toBe(200)

    m.cleanupOne.mockResolvedValue({ id: 3, status: "cleaned" })
    const del = await itemRoute.DELETE(req("DELETE"), params("3"))
    expect(del.status).toBe(200)
    expect((await del.json()).demoTenant.status).toBe("cleaned")

    expect((await itemRoute.POST(req("POST", { action: "nope" }), params("3"))).status).toBe(400)
  })

  it("surfaces template/cleaned refusals from the store", async () => {
    m.reset.mockRejectedValue(new m.DemoTenantError("The demo template cannot be modified by this action", 400))
    expect((await itemRoute.POST(req("POST", { action: "reset" }), params("1"))).status).toBe(400)
    m.cleanupOne.mockRejectedValue(new m.DemoTenantError("already cleaned", 409))
    expect((await itemRoute.DELETE(req("DELETE"), params("1"))).status).toBe(409)
  })
})

describe("cleanup cron", () => {
  const env = { ...process.env }
  afterEach(() => {
    process.env = { ...env }
  })

  it("requires the CRON_SECRET bearer token", async () => {
    process.env.CRON_SECRET = "s3cret"
    expect((await cronRoute.GET(new Request("http://t.test/api/cron/demo-tenant-cleanup"))).status).toBe(401)
    expect(
      (await cronRoute.GET(new Request("http://t.test", { headers: { authorization: "Bearer wrong" } }))).status,
    ).toBe(401)
    expect(m.cleanupAll).not.toHaveBeenCalled()

    m.cleanupAll.mockResolvedValue({ expired: 1, purged: 1, purgedTenantIds: [9], failed: [] })
    const ok = await cronRoute.GET(new Request("http://t.test", { headers: { authorization: "Bearer s3cret" } }))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ ok: true, purged: 1 })
    expect(m.cleanupAll).toHaveBeenCalledWith(null)
  })

  it("fails closed in production when no secret is configured", async () => {
    delete process.env.CRON_SECRET
    ;(process.env as any).NODE_ENV = "production"
    expect((await cronRoute.GET(new Request("http://t.test"))).status).toBe(401)
  })

  it("reports per-clone failures as ok:false", async () => {
    process.env.CRON_SECRET = "s"
    m.cleanupAll.mockResolvedValue({ expired: 0, purged: 0, purgedTenantIds: [], failed: [{ demoId: 1, tenantId: 2, error: "x" }] })
    const res = await cronRoute.GET(new Request("http://t.test", { headers: { authorization: "Bearer s" } }))
    expect((await res.json()).ok).toBe(false)
  })
})
