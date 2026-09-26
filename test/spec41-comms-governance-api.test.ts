import { beforeEach, describe, expect, it, vi } from "vitest"
import crypto from "node:crypto"

const m = vi.hoisted(() => ({
  requireTenantAdmin: vi.fn(),
  listProviderConfigs: vi.fn(),
  saveProviderConfig: vi.fn(),
  usageSnapshot: vi.fn(),
  listSuppressions: vi.fn(),
  addSuppression: vi.fn(),
  releaseSuppression: vi.fn(),
  ingestEmailEvents: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/platform-guard", () => ({
  requireTenantAdmin: m.requireTenantAdmin,
  effectiveTenantId: (ctx: any) => ctx.tenantId,
}))
vi.mock("@/lib/comms-governance/service", () => ({
  listProviderConfigs: m.listProviderConfigs,
  saveProviderConfig: m.saveProviderConfig,
  usageSnapshot: m.usageSnapshot,
  listSuppressions: m.listSuppressions,
  addSuppression: m.addSuppression,
  releaseSuppression: m.releaseSuppression,
  ingestEmailEvents: m.ingestEmailEvents,
}))
vi.mock("@/lib/system-monitoring", () => ({ monitorLogger: { warning: m.warn, error: m.error } }))

import { GET as providersGET, PUT as providersPUT } from "@/app/api/admin/comms/providers/route"
import { GET as suppGET, POST as suppPOST } from "@/app/api/admin/comms/suppressions/route"
import { DELETE as suppDELETE } from "@/app/api/admin/comms/suppressions/[id]/route"
import { POST as eventsPOST } from "@/app/api/comms/email-events/[provider]/route"
import { GovernanceError } from "@/lib/comms-governance/model"

const ALLOW = { ok: true, ctx: { tenantId: 7 }, session: { userId: 1, name: "A", email: "a@x.com" } }
const DENY_401 = { ok: false, status: 401, reason: "Not authenticated" }
const DENY_403 = { ok: false, status: 403, reason: "Insufficient tenant privileges" }

beforeEach(() => {
  for (const fn of Object.values(m)) (fn as any).mockReset?.()
  m.listProviderConfigs.mockResolvedValue([])
  m.usageSnapshot.mockResolvedValue([])
})

describe("provider config API — permission + tenant scope", () => {
  it("401 when unauthenticated", async () => {
    m.requireTenantAdmin.mockResolvedValue(DENY_401)
    expect((await providersGET()).status).toBe(401)
  })

  it("403 for a non-admin tenant user", async () => {
    m.requireTenantAdmin.mockResolvedValue(DENY_403)
    expect((await providersGET()).status).toBe(403)
  })

  it("lists configs for the session tenant only", async () => {
    m.requireTenantAdmin.mockResolvedValue(ALLOW)
    m.listProviderConfigs.mockResolvedValue([{ channel: "email", provider: "ses" }])
    const res = await providersGET()
    expect(res.status).toBe(200)
    expect(m.listProviderConfigs).toHaveBeenCalledWith(7)
    const body = await res.json()
    expect(body.catalog.channels).toContain("email")
  })

  it("saves with the session tenant + actor, never a body tenant id", async () => {
    m.requireTenantAdmin.mockResolvedValue(ALLOW)
    m.saveProviderConfig.mockResolvedValue({ channel: "email", provider: "ses", version: 2 })
    const req = new Request("http://x", { method: "PUT", body: JSON.stringify({ tenantId: 999, channel: "email", provider: "ses", enabled: true, credentialRef: "vault:k", settings: {}, expectedVersion: 1 }) })
    const res = await providersPUT(req)
    expect(res.status).toBe(200)
    expect(m.saveProviderConfig).toHaveBeenCalledWith(7, 1, expect.any(Object), 1)
  })

  it("maps a version conflict to 409", async () => {
    m.requireTenantAdmin.mockResolvedValue(ALLOW)
    m.saveProviderConfig.mockRejectedValue(new GovernanceError("version_conflict", "changed"))
    const req = new Request("http://x", { method: "PUT", body: JSON.stringify({ expectedVersion: 1 }) })
    expect((await providersPUT(req)).status).toBe(409)
  })
})

describe("suppression API — admin adds MANUAL only", () => {
  it("403 for a non-admin", async () => {
    m.requireTenantAdmin.mockResolvedValue(DENY_403)
    expect((await suppGET(new Request("http://x"))).status).toBe(403)
  })

  it("forces reason=manual regardless of the body", async () => {
    m.requireTenantAdmin.mockResolvedValue(ALLOW)
    const req = new Request("http://x", { method: "POST", body: JSON.stringify({ channel: "email", address: "a@b.com", reason: "opt_out" }) })
    const res = await suppPOST(req)
    expect(res.status).toBe(201)
    expect(m.addSuppression).toHaveBeenCalledWith(7, expect.objectContaining({ reason: "manual", source: "admin", actorId: 1 }))
  })

  it("rejects an unknown channel", async () => {
    m.requireTenantAdmin.mockResolvedValue(ALLOW)
    const req = new Request("http://x", { method: "POST", body: JSON.stringify({ channel: "nope", address: "a@b.com" }) })
    expect((await suppPOST(req)).status).toBe(400)
  })

  it("release maps consent_locked to 409 and not_found to 404", async () => {
    m.requireTenantAdmin.mockResolvedValue(ALLOW)
    m.releaseSuppression.mockRejectedValueOnce(new GovernanceError("consent_locked", "no"))
    expect((await suppDELETE(new Request("http://x"), { params: Promise.resolve({ id: "3" }) })).status).toBe(409)
    m.releaseSuppression.mockRejectedValueOnce(new GovernanceError("not_found", "no"))
    expect((await suppDELETE(new Request("http://x"), { params: Promise.resolve({ id: "9" }) })).status).toBe(404)
    expect(m.releaseSuppression).toHaveBeenLastCalledWith(7, 1, 9)
  })
})

describe("email events webhook — signature + attribution", () => {
  const secret = "webhook-secret"
  const body = JSON.stringify({ events: [] })
  const sign = (ts: string, b: string) => "sha256=" + crypto.createHmac("sha256", secret).update(`${ts}.${b}`).digest("hex")

  beforeEach(() => {
    process.env.COMMS_EMAIL_WEBHOOK_SECRET = secret
  })

  it("404 for an unknown provider", async () => {
    const res = await eventsPOST(new Request("http://x", { method: "POST", body }), { params: Promise.resolve({ provider: "carrier" }) })
    expect(res.status).toBe(404)
  })

  it("403 when the signature is missing or wrong", async () => {
    const res = await eventsPOST(new Request("http://x", { method: "POST", body }), { params: Promise.resolve({ provider: "ses" }) })
    expect(res.status).toBe(403)
    expect(m.ingestEmailEvents).not.toHaveBeenCalled()
  })

  it("ingests a correctly signed body and returns the counts", async () => {
    m.ingestEmailEvents.mockResolvedValue({ processed: 1, duplicates: 0, unattributed: 0 })
    const ts = String(Math.floor(Date.now() / 1000))
    const req = new Request("http://x", { method: "POST", headers: { "x-comm-timestamp": ts, "x-comm-signature": sign(ts, body) }, body })
    const res = await eventsPOST(req, { params: Promise.resolve({ provider: "ses" }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, processed: 1 })
    expect(m.ingestEmailEvents).toHaveBeenCalledWith("ses", { events: [] })
  })
})
