import { AsyncResource } from "node:async_hooks"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({ cookies: vi.fn(), active: vi.fn(), resolveTenant: vi.fn() }))
vi.mock("next/headers", () => ({ cookies: mock.cookies }))
vi.mock("jose", () => ({
  SignJWT: vi.fn(),
  jwtVerify: async (token: string) => { await Promise.resolve(); return { payload: JSON.parse(token) } },
}))
vi.mock("@/lib/session-store", () => ({ isSessionActive: mock.active, touchSession: vi.fn() }))
vi.mock("@/lib/tenant-service", () => ({ resolveTenantIdForUser: mock.resolveTenant }))
vi.mock("@/lib/whatsapp-platform", () => ({ resolveWhatsAppCaps: async () => ({ canManagePlatform: true }) }))
vi.mock("@/lib/whatsapp-health", async () => {
  const { getCurrentTenant } = await import("@/lib/tenant-context")
  return { getConnectionHealth: async () => {
    const tenant = getCurrentTenant()
    return { connected: !!tenant, integration: tenant ? { tenantId: tenant.tenantId } : null }
  } }
})
import { getSession } from "@/lib/auth"
import { getCurrentTenant, setCurrentTenant } from "@/lib/tenant-context"
import { GET as status } from "@/app/api/marketing/whatsapp/status/route"

// A clean async root is essential: pre-seeding a store in beforeEach masks
// the production bug, where no tenant container exists before cookies/JWT await.
const requestRoot = new AsyncResource("session-context-test-request")
const payload = { userId: 5, role: "admin", email: "admin@example.invalid", name: "Admin", tenantId: 7 }
function cookie(session: object | null) {
  return { get: () => session ? { value: JSON.stringify(session) } : undefined }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("SESSION_SECRET", "test-only")
  mock.cookies.mockResolvedValue(cookie(payload))
  mock.active.mockResolvedValue(true)
  mock.resolveTenant.mockResolvedValue(7)
})

describe("session tenant propagation across await", () => {
  it("makes the verified tenant visible to the calling route", () => requestRoot.runInAsyncScope(async () => {
    const session = await getSession()
    expect(session?.tenantId).toBe(7)
    expect(getCurrentTenant()?.tenantId).toBe(7)
    await Promise.resolve()
    expect(getCurrentTenant()?.tenantId).toBe(7)
  }))
  it("lets WhatsApp status find the saved tenant after authentication", () => requestRoot.runInAsyncScope(async () => {
    const response = await status()
    expect((await response.json()).health).toEqual({ connected: true, integration: { tenantId: 7 } })
  }))
  it("propagates a legacy user's resolved tenant", () => requestRoot.runInAsyncScope(async () => {
    mock.cookies.mockResolvedValue(cookie({ ...payload, tenantId: undefined }))
    const session = await getSession()
    expect(session?.tenantId).toBe(7)
    expect(getCurrentTenant()?.tenantId).toBe(7)
  }))
  it("isolates concurrent requests even when they finish out of order", () => requestRoot.runInAsyncScope(async () => {
    let release!: (value: any) => void
    mock.cookies.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      .mockResolvedValueOnce(cookie({ ...payload, tenantId: 22 }))
    const first = (async () => { await getSession(); await Promise.resolve(); return getCurrentTenant()?.tenantId })()
    const second = (async () => { await getSession(); return getCurrentTenant()?.tenantId })()
    expect(await second).toBe(22)
    release(cookie({ ...payload, tenantId: 11 }))
    expect(await first).toBe(11)
  }))
  it("clears inherited tenant context for unauthenticated requests", () => requestRoot.runInAsyncScope(async () => {
    setCurrentTenant({ tenantId: 99 })
    mock.cookies.mockResolvedValue(cookie(null))
    expect(await getSession()).toBeNull()
    expect(getCurrentTenant()).toBeNull()
  }))
  it("clears inherited tenant context for revoked sessions", () => requestRoot.runInAsyncScope(async () => {
    setCurrentTenant({ tenantId: 99 })
    mock.cookies.mockResolvedValue(cookie({ ...payload, sid: "revoked" }))
    mock.active.mockResolvedValue(false)
    expect(await getSession()).toBeNull()
    expect(getCurrentTenant()).toBeNull()
  }))
  it("retains authorized impersonation and ignores it for non-platform sessions", () => requestRoot.runInAsyncScope(async () => {
    mock.cookies.mockResolvedValue(cookie({ ...payload, platformRole: "platform_super_admin", impersonatedTenantId: 33 }))
    await getSession()
    expect(getCurrentTenant()?.tenantId).toBe(33)
    mock.cookies.mockResolvedValue(cookie({ ...payload, platformRole: "none", impersonatedTenantId: 44 }))
    await getSession()
    expect(getCurrentTenant()?.tenantId).toBe(7)
  }))
})
