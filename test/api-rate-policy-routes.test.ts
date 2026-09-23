import { beforeEach, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ guard: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), list: vi.fn(), keys: vi.fn(), snapshot: vi.fn(), usage: vi.fn(), tenant: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/platform-guard", () => ({ requireTenantAdmin: mock.guard, effectiveTenantId: (ctx: { tenantId: number }) => ctx.tenantId }))
vi.mock("@/lib/api-platform/rate-limit-policies", () => ({ createRatePolicy: mock.create, updateRatePolicy: mock.update, deleteRatePolicy: mock.remove, listRatePolicies: mock.list, RatePolicyError: class extends Error { status = 400 } }))
vi.mock("@/lib/api-keys-store", () => ({ listApiKeys: mock.keys }))
vi.mock("@/lib/api-platform/rate-limit-store", () => ({ snapshotSharedRateLimits: mock.snapshot }))
vi.mock("@/lib/api-platform/audit", () => ({ getApiUsageSummary: mock.usage }))
vi.mock("@/lib/tenant-service", () => ({ getTenantById: mock.tenant }))
import { GET, POST } from "@/app/api/admin/security/rate-limits/route"
import { PATCH, DELETE } from "@/app/api/admin/security/rate-limits/[id]/route"
const context = { params: Promise.resolve({ id: "8" }) }
const request = (body: unknown) => new Request("https://example.test/api/admin/security/rate-limits", { method: "POST", body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  mock.guard.mockResolvedValue({ ok: true, ctx: { userId: 4, tenantId: 7 } })
  mock.keys.mockResolvedValue([{ id: 5, name: "Key", tenant_id: 7 }])
  mock.snapshot.mockResolvedValue([])
  mock.list.mockResolvedValue([])
  mock.usage.mockResolvedValue({ totalRequests: 0, rateLimitedRequests: 0, requestsLast24h: 0, requestsLastHour: 0 })
  mock.tenant.mockResolvedValue({ plan: "starter" })
})
it("blocks tenant users without admin permission before accessing policy data", async () => {
  mock.guard.mockResolvedValue({ ok: false, status: 403, reason: "Forbidden" })
  expect((await GET()).status).toBe(403)
  expect((await POST(request({}))).status).toBe(403)
  expect((await PATCH(request({}), context)).status).toBe(403)
  expect((await DELETE(new Request("https://example.test", { method: "DELETE" }), context)).status).toBe(403)
  expect(mock.create).not.toHaveBeenCalled()
})
it("uses tenant and actor from verified context, ignoring client tenant_id", async () => {
  mock.create.mockResolvedValue({ id: 8 })
  expect((await POST(request({ tenant_id: 999 }))).status).toBe(201)
  expect(mock.create).toHaveBeenCalledWith(7, { tenant_id: 999 }, 4)
  mock.update.mockResolvedValue({ id: 8 })
  await PATCH(request({ tenant_id: 999 }), context)
  expect(mock.update).toHaveBeenCalledWith(7, 8, { tenant_id: 999 }, 4)
})
it("only asks for this tenant's key counters", async () => {
  await GET()
  expect(mock.snapshot).toHaveBeenCalledWith(7, [5])
  expect(mock.list).toHaveBeenCalledWith(7)
})
