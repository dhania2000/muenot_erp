import { beforeEach, describe, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ entitlements: vi.fn(), auth: vi.fn(), run: vi.fn(), actor: vi.fn(), query: vi.fn() }))
vi.mock("@/lib/platform/entitlement-guard", () => ({ getTenantEntitlements: mock.entitlements }))
vi.mock("@/lib/mobile-auth", () => ({ authenticateMobileRequest: mock.auth, auditMobileAction: vi.fn() }))
vi.mock("@/lib/tenant-scope", () => ({ runForTenant: (_: any, fn: any) => fn() }))
vi.mock("@/lib/actor-context", () => ({ setCurrentActor: mock.actor }))
vi.mock("@/lib/db", () => ({ query: mock.query }))
import { requireShopkeeperFeature } from "@/lib/shopkeeper"
import { withMobileAuth } from "@/lib/mobile-api"

const plan = (flags: string[]) => ({ feature_flags: flags })
const principal = { userId: 10, tenantId: 7, name: "Shop Owner", email: "owner@example.test", role: "admin" as const, tenantRole: "tenant_owner", sessionId: "s1" }
beforeEach(() => { vi.clearAllMocks(); mock.auth.mockResolvedValue(principal); mock.entitlements.mockResolvedValue(plan(["shopkeeper.mobile_app", "shopkeeper.whatsapp", "shopkeeper.inbox"])) })

describe("Shopkeeper plan enforcement", () => {
  it("requires both mobile base access and the requested feature", async () => {
    expect(await requireShopkeeperFeature(7, "inbox")).toEqual({ ok: true })
    mock.entitlements.mockResolvedValue(plan(["shopkeeper.mobile_app"]))
    expect(await requireShopkeeperFeature(7, "inbox")).toMatchObject({ ok: false, status: 403 })
  })
  it("does not authenticate a request without a valid mobile token", async () => {
    mock.auth.mockResolvedValue(null)
    const result: any = await withMobileAuth(new Request("https://example.test"), async () => "should-not-run", "inbox")
    expect(result.status).toBe(401)
  })
  it("derives feature authority from the token tenant, not request input", async () => {
    let seen = 0
    await withMobileAuth(new Request("https://example.test?tenant_id=999"), async p => { seen = p.tenantId; return "ok" }, "inbox")
    expect(seen).toBe(7)
    expect(mock.entitlements).toHaveBeenCalledWith(7)
    expect(mock.entitlements).not.toHaveBeenCalledWith(999)
  })
})
