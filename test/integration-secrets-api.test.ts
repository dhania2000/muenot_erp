import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec 9 — tenant integration-secrets API routes (#20-21, #115-117).
 *
 * The routes are the tenant-facing surface. These tests mock the auth boundary
 * and the store so they focus purely on the HTTP contract: authentication,
 * tenant-ADMIN authorization (a non-admin tenant member cannot touch integration
 * secrets), input validation, and that actor identity + Idempotency-Key are
 * forwarded from the verified session/headers rather than the request body.
 */

const auth = vi.hoisted(() => ({ current: null as any }))
vi.mock("@/lib/api-auth", () => ({
  requireTenant: vi.fn(async () => auth.current),
}))

const store = vi.hoisted(() => ({
  setIntegrationSecret: vi.fn(async () => ({ version: 1, vaultKind: "db", health: "healthy", deduped: false })),
  rotateIntegrationSecret: vi.fn(async () => ({ version: 2, vaultKind: "db", health: "healthy", deduped: false })),
  rollbackIntegrationSecret: vi.fn(async () => ({ version: 1, fromVersion: 2, deduped: false })),
  testIntegrationConnection: vi.fn(async () => ({ vaultKind: "db", health: "healthy", detail: null })),
  getIntegrationAudit: vi.fn(async () => [{ id: 1, integrationKey: "stripe", fieldKey: "secret_key", action: "set", actorEmail: "a@t", detail: null, at: "t" }]),
  getIntegrationsOverview: vi.fn(async () => []),
}))
vi.mock("@/lib/secrets/tenant-integration-store", () => store)

import { POST as setSecret, GET as listSecrets } from "@/app/api/settings/integration-secrets/route"
import { POST as rotateSecret } from "@/app/api/settings/integration-secrets/rotate/route"
import { POST as rollbackSecret } from "@/app/api/settings/integration-secrets/rollback/route"
import { POST as testConn } from "@/app/api/settings/integration-secrets/test/route"
import { GET as auditHistory } from "@/app/api/settings/integration-secrets/audit/route"

const ADMIN = { session: { userId: 42, email: "admin@t.test", role: "admin" }, tenantId: 7 }
const MEMBER = { session: { userId: 99, email: "member@t.test", role: "member" }, tenantId: 7 }

function post(url: string, body: unknown, headers: Record<string, string> = {}): any {
  return new Request(url, { method: "POST", body: JSON.stringify(body), headers })
}

beforeEach(() => {
  auth.current = ADMIN
  Object.values(store).forEach((fn) => (fn as any).mockClear())
})
afterEach(() => vi.clearAllMocks())

describe("authentication + authorization", () => {
  it("401s an unauthenticated caller", async () => {
    auth.current = null
    const res = await setSecret(post("http://x/api/settings/integration-secrets", {}) as any)
    expect(res.status).toBe(401)
  })

  it("403s a non-admin tenant member on every mutating route", async () => {
    auth.current = MEMBER
    for (const handler of [setSecret, rotateSecret, rollbackSecret, testConn]) {
      const res = await handler(post("http://x/r", { integrationKey: "stripe", fieldKey: "secret_key", value: "v", targetVersion: 1 }) as any)
      expect(res.status).toBe(403)
    }
    expect(store.setIntegrationSecret).not.toHaveBeenCalled()
    expect(store.rotateIntegrationSecret).not.toHaveBeenCalled()
    expect(store.rollbackIntegrationSecret).not.toHaveBeenCalled()
  })

  it("403s a non-admin on the audit history route (trail names actors)", async () => {
    auth.current = MEMBER
    const res = await auditHistory(new Request("http://x/api/settings/integration-secrets/audit") as any)
    expect(res.status).toBe(403)
  })
})

describe("input validation", () => {
  it("400s when required fields are missing", async () => {
    const missingValue = await setSecret(post("http://x/r", { integrationKey: "stripe", fieldKey: "secret_key" }) as any)
    expect(missingValue.status).toBe(400)
    const badRollback = await rollbackSecret(post("http://x/r", { integrationKey: "stripe", fieldKey: "secret_key", targetVersion: 0 }) as any)
    expect(badRollback.status).toBe(400)
  })
})

describe("happy path — forwards verified identity, not body-supplied actor", () => {
  it("set forwards the session userId/email and the Idempotency-Key header", async () => {
    const res = await setSecret(
      post(
        "http://x/r",
        { integrationKey: "stripe", fieldKey: "secret_key", value: "sk_live_x", vaultChoice: "db", actor: { userId: 1, email: "spoof@evil.test" } },
        { "idempotency-key": "idem-9" },
      ) as any,
    )
    expect(res.status).toBe(200)
    expect(store.setIntegrationSecret).toHaveBeenCalledTimes(1)
    const arg = store.setIntegrationSecret.mock.calls[0][0] as any
    expect(arg.actor).toEqual({ userId: 42, email: "admin@t.test" }) // from session, NOT the spoofed body
    expect(arg.idempotencyKey).toBe("idem-9")
  })

  it("rotate returns the new version", async () => {
    const res = await rotateSecret(post("http://x/r", { integrationKey: "stripe", fieldKey: "secret_key", value: "sk_live_y" }) as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, version: 2 })
  })

  it("test-connection returns health without moving secret material", async () => {
    const res = await testConn(post("http://x/r", { integrationKey: "stripe" }) as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, health: "healthy" })
  })

  it("GET overview and audit succeed for an admin", async () => {
    const overview = await listSecrets(new Request("http://x/api/settings/integration-secrets") as any)
    expect(overview.status).toBe(200)
    const audit = await auditHistory(new Request("http://x/api/settings/integration-secrets/audit?integrationKey=stripe") as any)
    expect(audit.status).toBe(200)
    expect(store.getIntegrationAudit).toHaveBeenCalledWith({ integrationKey: "stripe", limit: undefined })
  })
})
