import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  session: vi.fn(),
  tenant: vi.fn(),
  getGeo: vi.fn(),
  upsertGeo: vi.fn(),
  getDevPolicy: vi.fn(),
  upsertDevPolicy: vi.fn(),
  listDevices: vi.fn(),
  enroll: vi.fn(),
  revoke: vi.fn(),
  ownerTenant: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth", () => ({ getSession: m.session }))
vi.mock("@/lib/tenant-context", () => ({ getCurrentTenant: m.tenant }))
vi.mock("@/lib/geo-policy-store", () => ({ getGeoPolicy: m.getGeo, upsertGeoPolicy: m.upsertGeo }))
vi.mock("@/lib/managed-device-store", () => ({
  getManagedDevicePolicy: m.getDevPolicy,
  upsertManagedDevicePolicy: m.upsertDevPolicy,
  listManagedDevices: m.listDevices,
  enrollManagedDevice: m.enroll,
  revokeManagedDevice: m.revoke,
}))
vi.mock("@/lib/tenant-service", () => ({ resolveTenantIdForUser: m.ownerTenant }))
vi.mock("@/lib/audit-log-store", () => ({
  recordAuditLogFromRequest: m.audit,
  AUDIT_ACTIONS: {
    geoPolicyUpdate: "geo_policy.update",
    managedDevicePolicyUpdate: "managed_device_policy.update",
    managedDeviceEnroll: "managed_device.enroll",
    managedDeviceRevoke: "managed_device.revoke",
  },
}))

import * as geoRoute from "@/app/api/admin/security/geo-policy/route"
import * as devRoute from "@/app/api/admin/security/managed-devices/route"
import * as devIdRoute from "@/app/api/admin/security/managed-devices/[id]/route"

const admin = { userId: 1, role: "admin", name: "Ada", email: "ada@t1.test" }
const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://t.test/api", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

beforeEach(() => {
  vi.resetAllMocks()
  m.session.mockResolvedValue(admin)
  m.tenant.mockReturnValue({ tenantId: 10 })
  m.getGeo.mockResolvedValue({ tenantId: 10, enabled: false, mode: "allow", countries: [], unknownAction: "block", emergencyAccess: false })
  m.getDevPolicy.mockResolvedValue({ tenantId: 10, required: false, emergencyAccess: false })
  m.audit.mockResolvedValue(undefined)
})

describe("permissions", () => {
  it("rejects non-admins on every route", async () => {
    m.session.mockResolvedValue({ ...admin, role: "employee" })
    expect((await geoRoute.GET()).status).toBe(403)
    expect((await geoRoute.PUT(req("PUT", { enabled: false }))).status).toBe(403)
    expect((await devRoute.GET()).status).toBe(403)
    expect((await devRoute.PUT(req("PUT", { required: true }))).status).toBe(403)
    expect((await devRoute.POST(req("POST", {}))).status).toBe(403)
    expect((await devIdRoute.DELETE(req("DELETE"), { params: Promise.resolve({ id: "1" }) })).status).toBe(403)
    expect(m.upsertGeo).not.toHaveBeenCalled()
    expect(m.enroll).not.toHaveBeenCalled()
    expect(m.revoke).not.toHaveBeenCalled()
  })
  it("rejects anonymous callers", async () => {
    m.session.mockResolvedValue(null)
    expect((await geoRoute.GET()).status).toBe(403)
  })
})

describe("geo policy API", () => {
  it("scopes updates to the context tenant, ignoring a body tenantId", async () => {
    m.upsertGeo.mockResolvedValue({ tenantId: 10, enabled: true, mode: "allow", countries: ["IN"], unknownAction: "block", emergencyAccess: true })
    const res = await geoRoute.PUT(req("PUT", { tenantId: 99, enabled: true, mode: "allow", countries: ["IN"] }))
    expect(res.status).toBe(200)
    expect(m.upsertGeo.mock.calls[0][0]).toBe(10)
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "geo_policy.update" }))
  })
  it("returns 400 for validation failures (e.g. empty enabled allow-list)", async () => {
    m.upsertGeo.mockRejectedValue(new Error("An enabled allow-list must include at least one country"))
    const res = await geoRoute.PUT(req("PUT", { enabled: true, mode: "allow", countries: [] }))
    expect(res.status).toBe(400)
    expect(m.audit).not.toHaveBeenCalled()
  })
  it("requires a tenant context", async () => {
    m.tenant.mockReturnValue(null)
    expect((await geoRoute.PUT(req("PUT", { enabled: false }))).status).toBe(400)
  })
})

describe("managed device API", () => {
  it("validates the policy body", async () => {
    expect((await devRoute.PUT(req("PUT", { required: "yes" }))).status).toBe(400)
    expect((await devRoute.PUT(req("PUT", { required: true, emergencyAccess: 1 }))).status).toBe(400)
    expect(m.upsertDevPolicy).not.toHaveBeenCalled()
  })
  it("refuses to enroll a device for a user in another tenant", async () => {
    m.ownerTenant.mockResolvedValue(20)
    const res = await devRoute.POST(req("POST", { userId: 55, label: "Laptop" }))
    expect(res.status).toBe(404)
    expect(m.enroll).not.toHaveBeenCalled()
  })
  it("rejects malformed userId and label", async () => {
    expect((await devRoute.POST(req("POST", { userId: -3 }))).status).toBe(400)
    expect((await devRoute.POST(req("POST", { label: 42 }))).status).toBe(400)
  })
  it("passes the Idempotency-Key through and does not re-audit a replay", async () => {
    m.ownerTenant.mockResolvedValue(10)
    const device = { id: 7, deviceId: "dev_x", label: "Laptop" }
    m.enroll.mockResolvedValueOnce({ device, assertion: "a1", expiresInSeconds: 60, replayed: false })
    m.enroll.mockResolvedValueOnce({ device, assertion: "a2", expiresInSeconds: 60, replayed: true })
    const first = await devRoute.POST(req("POST", { userId: 5, label: "Laptop" }, { "idempotency-key": "k1" }))
    const second = await devRoute.POST(req("POST", { userId: 5, label: "Laptop" }, { "idempotency-key": "k1" }))
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(m.enroll.mock.calls[0][2]).toMatchObject({ userId: 5, idempotencyKey: "k1" })
    expect(m.enroll.mock.calls[0][0]).toBe(10)
    expect(m.audit).toHaveBeenCalledTimes(1)
  })
  it("maps idempotency conflicts to 409", async () => {
    m.ownerTenant.mockResolvedValue(10)
    m.enroll.mockRejectedValue(new Error("Idempotency key was already used for a different user"))
    expect((await devRoute.POST(req("POST", { userId: 5 }, { "idempotency-key": "k1" }))).status).toBe(409)
  })
  it("revocation is tenant-scoped: another tenant's device returns 404", async () => {
    m.revoke.mockResolvedValue(false)
    const res = await devIdRoute.DELETE(req("DELETE"), { params: Promise.resolve({ id: "9" }) })
    expect(res.status).toBe(404)
    expect(m.revoke).toHaveBeenCalledWith(10, expect.anything(), 9)
  })
  it("revokes and audits", async () => {
    m.revoke.mockResolvedValue(true)
    const res = await devIdRoute.DELETE(req("DELETE"), { params: Promise.resolve({ id: "9" }) })
    expect(res.status).toBe(200)
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "managed_device.revoke" }))
  })
  it("rejects a non-numeric device id", async () => {
    expect((await devIdRoute.DELETE(req("DELETE"), { params: Promise.resolve({ id: "abc" }) })).status).toBe(400)
  })
})
