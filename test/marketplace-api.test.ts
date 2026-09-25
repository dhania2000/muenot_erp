import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/**
 * Spec 15 — Integration marketplace API routes (#88-89).
 *
 * The routes are the tenant-facing surface. These tests mock the auth boundary
 * and the store so they focus purely on the HTTP contract: authentication,
 * authorization (read-only VIEW is open to any tenant member; every MUTATION and
 * the actor-naming audit trail are tenant-ADMIN only), input validation, and
 * that actor identity + Idempotency-Key come from the verified session/headers
 * rather than the request body.
 */

const auth = vi.hoisted(() => ({ current: null as any }))
vi.mock("@/lib/api-auth", () => ({
  requireTenant: vi.fn(async () => auth.current),
}))

const store = vi.hoisted(() => ({
  getMarketplaceOverview: vi.fn(async () => [{ key: "slack", status: "not_installed" }]),
  installConnector: vi.fn(async () => ({ status: "installed", health: "healthy", grantedScopes: ["chat:write"], deduped: false })),
  reconnectConnector: vi.fn(async () => ({ status: "installed", health: "healthy", grantedScopes: ["chat:write"], deduped: false })),
  disconnectConnector: vi.fn(async () => ({ status: "disconnected", revoked: 2, deduped: false })),
  checkConnectorHealth: vi.fn(async () => ({ health: "healthy", detail: null })),
  getConnectorPermissionReview: vi.fn(async () => [{ key: "chat:write", label: "Post messages", description: "", required: true, granted: true }]),
  getConnectorAudit: vi.fn(async () => [{ id: 1, connectorKey: "slack", action: "install", actorEmail: "a@t", detail: null, at: "t" }]),
}))
vi.mock("@/lib/marketplace/connector-store", () => store)

import { GET as overview } from "@/app/api/settings/marketplace/route"
import { POST as install } from "@/app/api/settings/marketplace/install/route"
import { POST as reconnect } from "@/app/api/settings/marketplace/reconnect/route"
import { POST as disconnect } from "@/app/api/settings/marketplace/disconnect/route"
import { POST as health } from "@/app/api/settings/marketplace/health/route"
import { GET as permissions } from "@/app/api/settings/marketplace/permissions/route"
import { GET as audit } from "@/app/api/settings/marketplace/audit/route"

const ADMIN = { session: { userId: 42, email: "admin@t.test", role: "admin" }, tenantId: 7 }
const MEMBER = { session: { userId: 99, email: "member@t.test", role: "member" }, tenantId: 7 }

function post(url: string, body: unknown, headers: Record<string, string> = {}): any {
  return new Request(url, { method: "POST", body: JSON.stringify(body), headers })
}
function get(url: string): any {
  return new NextRequest(url)
}

beforeEach(() => {
  auth.current = ADMIN
  Object.values(store).forEach((fn) => (fn as any).mockClear())
})
afterEach(() => vi.clearAllMocks())

describe("authentication", () => {
  it("401s an unauthenticated caller on every route", async () => {
    auth.current = null
    expect((await overview()).status).toBe(401)
    expect((await install(post("http://x/i", {}))).status).toBe(401)
    expect((await reconnect(post("http://x/r", {}))).status).toBe(401)
    expect((await disconnect(post("http://x/d", {}))).status).toBe(401)
    expect((await health(post("http://x/h", {}))).status).toBe(401)
    expect((await permissions(get("http://x/p?connectorKey=slack"))).status).toBe(401)
    expect((await audit(get("http://x/a"))).status).toBe(401)
  })
})

describe("authorization", () => {
  it("403s a non-admin member on every mutating route", async () => {
    auth.current = MEMBER
    const body = { connectorKey: "slack" }
    for (const handler of [install, reconnect, disconnect, health]) {
      expect((await handler(post("http://x/m", body))).status).toBe(403)
    }
    expect(store.installConnector).not.toHaveBeenCalled()
    expect(store.reconnectConnector).not.toHaveBeenCalled()
    expect(store.disconnectConnector).not.toHaveBeenCalled()
    expect(store.checkConnectorHealth).not.toHaveBeenCalled()
  })

  it("403s a non-admin on the audit history route (it names actors)", async () => {
    auth.current = MEMBER
    expect((await audit(get("http://x/a"))).status).toBe(403)
    expect(store.getConnectorAudit).not.toHaveBeenCalled()
  })

  it("allows any tenant member to VIEW the catalog and review permissions", async () => {
    auth.current = MEMBER
    expect((await overview()).status).toBe(200)
    expect((await permissions(get("http://x/p?connectorKey=slack"))).status).toBe(200)
  })
})

describe("input validation", () => {
  it("400s a mutating route with no connectorKey", async () => {
    expect((await install(post("http://x/i", {}))).status).toBe(400)
    expect((await disconnect(post("http://x/d", {}))).status).toBe(400)
  })

  it("400s a malformed JSON body", async () => {
    const bad = new Request("http://x/i", { method: "POST", body: "{not json" }) as any
    expect((await install(bad)).status).toBe(400)
  })

  it("400s the permission review with no connectorKey", async () => {
    expect((await permissions(get("http://x/p"))).status).toBe(400)
  })
})

describe("happy path — forwards verified identity, not body-supplied actor", () => {
  it("install forwards the session actor and the Idempotency-Key header", async () => {
    const res = await install(
      post(
        "http://x/i",
        { connectorKey: "slack", requestedScopes: ["chat:write"], credentials: { bot_token: "xoxb-1" }, actor: { userId: 1, email: "spoof@evil.test" } },
        { "idempotency-key": "idem-9" },
      ),
    )
    expect(res.status).toBe(200)
    expect(store.installConnector).toHaveBeenCalledTimes(1)
    const arg = store.installConnector.mock.calls[0][0] as any
    expect(arg.actor).toEqual({ userId: 42, email: "admin@t.test" }) // from session, NOT the body
    expect(arg.idempotencyKey).toBe("idem-9")
    expect(arg.connectorKey).toBe("slack")
  })

  it("disconnect returns the revoked count", async () => {
    const res = await disconnect(post("http://x/d", { connectorKey: "slack" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, revoked: 2 })
  })

  it("health returns the classified state", async () => {
    const res = await health(post("http://x/h", { connectorKey: "slack" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, health: "healthy" })
  })

  it("audit forwards the connector filter for an admin", async () => {
    const res = await audit(get("http://x/a?connectorKey=slack&limit=25"))
    expect(res.status).toBe(200)
    expect(store.getConnectorAudit).toHaveBeenCalledWith({ connectorKey: "slack", limit: 25 })
  })
})
