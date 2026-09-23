import { beforeEach, describe, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ guard: vi.fn(), create: vi.fn(), edit: vi.fn(), publish: vi.fn(), list: vi.fn(), get: vi.fn(), latest: vi.fn(), rate: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/platform-guard", () => ({ requirePlatformSuperAdmin: mock.guard }))
vi.mock("@/lib/mobile-app-releases", () => ({ createRelease: mock.create, editDraft: mock.edit, setReleasePublished: mock.publish, listReleases: mock.list, getRelease: mock.get, latestPublicRelease: mock.latest }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mock.rate, getClientIp: () => "127.0.0.1" }))

import { GET as list, POST as create } from "@/app/api/platform/mobile-app/releases/route"
import { PATCH as edit } from "@/app/api/platform/mobile-app/releases/[id]/route"
import { POST as publication } from "@/app/api/platform/mobile-app/releases/[id]/publication/route"
import { GET as version } from "@/app/api/mobile/v1/app-version/route"

const context = { params: Promise.resolve({ id: "7" }) }
const request = (body: unknown) => new Request("https://erp.muenot.co.in/api/platform/mobile-app/releases", { method: "POST", body: JSON.stringify(body) })
beforeEach(() => {
  vi.clearAllMocks()
  mock.rate.mockReturnValue({ allowed: true })
  mock.guard.mockResolvedValue({ ok: true, ctx: { userId: 12 }, session: { email: "admin@example.test" } })
})

describe("platform release routes", () => {
  it.each([{ ok: false, status: 401, reason: "Unauthorized" }, { ok: false, status: 403, reason: "Forbidden" }])("blocks non-super-admin writes before touching the service", async guard => {
    mock.guard.mockResolvedValue(guard)
    expect((await create(request({}))).status).toBe(guard.status)
    expect((await edit(request({}), context)).status).toBe(guard.status)
    expect((await publication(request({ publish: true }), context)).status).toBe(guard.status)
    expect(mock.create).not.toHaveBeenCalled()
    expect(mock.edit).not.toHaveBeenCalled()
    expect(mock.publish).not.toHaveBeenCalled()
  })
  it("takes the audit actor from the verified Super Admin session", async () => {
    mock.create.mockResolvedValue({ id: 7 })
    expect((await create(request({ actorUserId: 999 }))).status).toBe(201)
    expect(mock.create).toHaveBeenCalledWith({ actorUserId: 999 }, { userId: 12, email: "admin@example.test" })
  })
  it("rejects malformed publication requests", async () => {
    expect((await publication(request({ publish: "yes" }), context)).status).toBe(400)
    expect(mock.publish).not.toHaveBeenCalled()
  })
  it("only exposes draft records through the guarded list", async () => {
    mock.list.mockResolvedValue([{ id: 7, status: "draft" }])
    const response = await list()
    expect(response.status).toBe(200)
    expect((await response.json()).releases[0].status).toBe("draft")
  })
})

describe("public version route", () => {
  it("does not expose a draft when no published release exists", async () => {
    mock.latest.mockResolvedValue(null)
    const response = await version(new Request("https://erp.muenot.co.in/api/mobile/v1/app-version"))
    expect(response.status).toBe(404)
    expect(JSON.stringify(await response.json())).not.toContain("draft")
  })
  it("returns exactly public latest metadata without admin or signing fields", async () => {
    mock.latest.mockResolvedValue({ platform: "android", latestVersion: "1.1.0", latestVersionCode: 3, minimumVersionCode: 2, forceUpdate: true, apkUrl: "https://downloads.example/a.apk", apkSize: 123, apkSha256: "a".repeat(64), releaseNotes: ["Fix"], publishedAt: "2026-09-23" })
    const response = await version(new Request("https://erp.muenot.co.in/api/mobile/v1/app-version"))
    const body = await response.json()
    expect(body).toMatchObject({ latestVersionCode: 3, minimumVersionCode: 2, forceUpdate: true })
    expect(body).not.toHaveProperty("createdBy")
    expect(body).not.toHaveProperty("keystore")
  })
  it("rate limits unauthenticated checks", async () => {
    mock.rate.mockReturnValue({ allowed: false, retryAfter: 30 })
    expect((await version(new Request("https://erp.muenot.co.in/api/mobile/v1/app-version"))).status).toBe(429)
    expect(mock.latest).not.toHaveBeenCalled()
  })
})
