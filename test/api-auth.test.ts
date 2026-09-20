import { beforeEach, describe, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({
  session: vi.fn(), feature: vi.fn(), action: vi.fn(), tenant: vi.fn(),
  key: vi.fn(), touch: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({ getSession: mock.session }))
vi.mock("@/lib/permissions", () => ({ userHasFeature: mock.feature }))
vi.mock("@/lib/permission-store", () => ({ hasActionGrant: mock.action }))
vi.mock("@/lib/tenant-context", () => ({ getCurrentTenant: mock.tenant }))
vi.mock("@/lib/api-keys-store", () => ({ findKeyByPlaintext: mock.key, touchKeyUsage: mock.touch }))
import { requireFeature, requireModuleAction, getTenantId, requireTenant, authenticateApiKey, hasScope } from "@/lib/api-auth"

const session = { userId: 5, role: "employee", tenantId: 7 }
beforeEach(() => {
  vi.resetAllMocks()
  mock.session.mockResolvedValue(session)
  mock.tenant.mockReturnValue(null)
  mock.touch.mockResolvedValue(undefined)
})

describe("browser authentication compatibility exports", () => {
  it("all four session guards fail closed without a session", async () => {
    mock.session.mockResolvedValue(null)
    mock.tenant.mockReturnValue({ tenantId: 99 })
    expect(await requireFeature("sales")).toBeNull()
    expect(await requireModuleAction("sales.leads", "export")).toBeNull()
    expect(await getTenantId()).toBeNull()
    expect(await requireTenant()).toBeNull()
    expect(mock.feature).not.toHaveBeenCalled()
    expect(mock.action).not.toHaveBeenCalled()
  })
  it("preserves feature checks", async () => {
    mock.feature.mockResolvedValue(false)
    expect(await requireFeature("sales")).toBeNull()
    mock.feature.mockResolvedValue(true)
    expect(await requireFeature("sales")).toEqual(session)
    expect(mock.feature).toHaveBeenCalledWith(5, "employee", "sales")
  })
  it("preserves module action checks and existing admin behavior", async () => {
    mock.action.mockResolvedValue(false)
    expect(await requireModuleAction("sales.leads", "export")).toBeNull()
    mock.action.mockResolvedValue(true)
    expect(await requireModuleAction("sales.leads", "export")).toEqual(session)
    expect(mock.action).toHaveBeenCalledWith(5, "employee", "sales.leads", "export")
    mock.session.mockResolvedValue({ ...session, role: "admin" })
    mock.action.mockClear()
    expect(await requireModuleAction("sales.leads", "export")).toEqual({ ...session, role: "admin" })
    expect(mock.action).not.toHaveBeenCalled()
  })
  it("derives tenant from session before authenticated context", async () => {
    mock.tenant.mockReturnValue({ tenantId: 99 })
    expect(await getTenantId()).toBe(7)
    expect(await requireTenant()).toEqual({ session, tenantId: 7 })
    mock.session.mockResolvedValue({ ...session, tenantId: null })
    expect(await getTenantId()).toBe(99)
    expect(await requireTenant()).toEqual({ session: { ...session, tenantId: null }, tenantId: 99 })
    mock.tenant.mockReturnValue(null)
    expect(await getTenantId()).toBeNull()
    expect(await requireTenant()).toBeNull()
  })
})

describe("public API-key authentication remains available", () => {
  const request = () => new Request("https://erp.example/api/v1/clients", { headers: { authorization: "Bearer mn_test" } })
  it("rejects missing, unknown, revoked and expired keys", async () => {
    expect(await authenticateApiKey(new Request("https://erp.example/api/v1/clients"))).toBeNull()
    expect(mock.key).not.toHaveBeenCalled()
    mock.key.mockResolvedValue(null)
    expect(await authenticateApiKey(request())).toBeNull()
    mock.key.mockResolvedValue({ status: "revoked" })
    expect(await authenticateApiKey(request())).toBeNull()
    mock.key.mockResolvedValue({ status: "active", expires_at: "2000-01-01" })
    expect(await authenticateApiKey(request())).toBeNull()
    expect(mock.touch).not.toHaveBeenCalled()
  })
  it("returns key tenant/scopes without granting browser-session access", async () => {
    mock.key.mockResolvedValue({ id: 3, tenant_id: 8, status: "active", expires_at: null, scopes: "clients:read" })
    const auth = await authenticateApiKey(request())
    expect(auth).toEqual({ keyId: 3, tenantId: 8, scopes: ["clients:read"] })
    expect(hasScope(auth!, "clients:read")).toBe(true)
    expect(hasScope(auth!, "clients:write")).toBe(false)
    expect(mock.touch).toHaveBeenCalledWith(3)
    expect(mock.session).not.toHaveBeenCalled()
  })
})
