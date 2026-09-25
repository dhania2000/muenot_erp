import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  session: vi.fn(),
  tenant: vi.fn(),
  getChecklist: vi.fn(),
  setStepState: vi.fn(),
  setDismissed: vi.fn(),
  author: vi.fn(),
  viewer: vi.fn(),
  create: vi.fn(),
  publish: vi.fn(),
  listAll: vi.fn(),
  listForViewer: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth", () => ({ getSession: m.session }))
vi.mock("@/lib/tenant-context", () => ({ getCurrentTenant: m.tenant }))
vi.mock("@/lib/audit-log-store", () => ({ captureAuditContext: vi.fn(async () => ({})) }))
vi.mock("@/lib/onboarding/store", () => ({ getChecklist: m.getChecklist, setStepState: m.setStepState, setDismissed: m.setDismissed }))
vi.mock("@/lib/product-updates/guard", () => ({ isProductUpdateAuthor: m.author, resolveViewer: m.viewer }))
vi.mock("@/lib/product-updates/store", () => ({ createUpdate: m.create, publishUpdate: m.publish, listAll: m.listAll, listForViewer: m.listForViewer }))

import * as onboarding from "@/app/api/onboarding/route"
import * as updates from "@/app/api/product-updates/route"

const admin = { userId: 3, email: "a@t", role: "admin", tenantId: 1 }
const req = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://t.test${url}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
const validNote = { version: "2027.1.0", title: "New", body: "Details", category: "feature", audienceType: "all" }

beforeEach(() => {
  vi.clearAllMocks()
  m.tenant.mockReturnValue({ tenantId: 7 })
  m.getChecklist.mockResolvedValue({ steps: [], total: 5, completed: 0 })
  m.setStepState.mockResolvedValue({ changed: true, checklist: {} })
})

describe("/api/onboarding", () => {
  it("401s without a session and 403s for non-admins", async () => {
    m.session.mockResolvedValue(null)
    expect((await onboarding.GET()).status).toBe(401)
    m.session.mockResolvedValue({ ...admin, role: "employee" })
    expect((await onboarding.GET()).status).toBe(403)
  })

  it("uses the effective tenant from context, never client input", async () => {
    m.session.mockResolvedValue(admin)
    await onboarding.GET()
    expect(m.getChecklist).toHaveBeenCalledWith(7)
    await onboarding.PATCH(req("/api/onboarding", "PATCH", { step: "email", state: "done", tenantId: 99 }))
    expect(m.setStepState).toHaveBeenCalledWith(7, 3, "email", "done", expect.anything())
  })

  it("400s without a tenant in context and for unknown steps", async () => {
    m.session.mockResolvedValue({ ...admin, tenantId: null })
    m.tenant.mockReturnValue(null)
    expect((await onboarding.GET()).status).toBe(400)
    m.tenant.mockReturnValue({ tenantId: 7 })
    const res = await onboarding.PATCH(req("/api/onboarding", "PATCH", { step: "payroll", state: "done" }))
    expect(res.status).toBe(400)
    expect(m.setStepState).not.toHaveBeenCalled()
  })

  it("hides store failures behind a generic 500", async () => {
    m.session.mockResolvedValue(admin)
    m.getChecklist.mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1"))
    vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await onboarding.GET()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("10.0.0.1")
  })
})

describe("/api/product-updates", () => {
  it("forbids tenant users from authoring or managing", async () => {
    m.session.mockResolvedValue(admin)
    m.author.mockResolvedValue(false)
    expect((await updates.POST(req("/api/product-updates", "POST", validNote))).status).toBe(403)
    expect((await updates.GET(req("/api/product-updates?scope=manage", "GET"))).status).toBe(403)
    expect(m.create).not.toHaveBeenCalled()
  })

  it("lists viewer updates for the resolved tenant viewer", async () => {
    m.session.mockResolvedValue(admin)
    m.viewer.mockResolvedValue({ tenantId: 7, role: "admin" })
    m.listForViewer.mockResolvedValue({ updates: [], unread: 0 })
    const res = await updates.GET(req("/api/product-updates", "GET"))
    expect(res.status).toBe(200)
    expect(m.listForViewer).toHaveBeenCalledWith({ tenantId: 7, role: "admin" }, 3)
  })

  it("replays idempotent creates without publishing again", async () => {
    m.session.mockResolvedValue(admin)
    m.author.mockResolvedValue(true)
    m.create.mockResolvedValue({ update: { id: 11 }, replayed: true })
    const res = await updates.POST(req("/api/product-updates", "POST", { ...validNote, publish: true }, { "Idempotency-Key": "abc-12345678" }))
    expect(res.status).toBe(200)
    expect(res.headers.get("Idempotent-Replayed")).toBe("true")
    expect(m.create.mock.calls[0][3]).toEqual({ idempotencyKey: "abc-12345678" })
    expect(m.publish).not.toHaveBeenCalled()
  })

  it("400s on a malformed idempotency key or invalid body", async () => {
    m.session.mockResolvedValue(admin)
    m.author.mockResolvedValue(true)
    expect((await updates.POST(req("/api/product-updates", "POST", validNote, { "Idempotency-Key": "bad key" }))).status).toBe(400)
    expect((await updates.POST(req("/api/product-updates", "POST", { ...validNote, version: "" }))).status).toBe(400)
    expect(m.create).not.toHaveBeenCalled()
  })
})
