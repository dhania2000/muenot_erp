import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Route-contract tests for the production sandbox / change-approval API.
 * The service layer is fully mocked, so these assert the HTTP concerns the
 * routes own: permission gating (tenant-admin vs tenant-owner), id validation,
 * idempotency-key pass-through, actor derivation from the session (never the
 * body), and SandboxError → status/code mapping.
 */

const m = vi.hoisted(() => {
  class SandboxError extends Error {
    status: number
    code: string
    constructor(message: string, code = "SANDBOX_ERROR", status = 400) {
      super(message)
      this.code = code
      this.status = status
    }
  }
  return {
    SandboxError,
    admin: vi.fn(),
    owner: vi.fn(),
    getOverview: vi.fn(),
    configure: vi.fn(),
    copy: vi.fn(),
    createChange: vi.fn(),
    submitChange: vi.fn(),
    decideChange: vi.fn(),
    promoteChange: vi.fn(),
    rollbackChange: vi.fn(),
    getChangeDetail: vi.fn(),
  }
})

vi.mock("server-only", () => ({}))
vi.mock("@/lib/platform-guard", () => ({ requireTenantAdmin: m.admin, requireTenantOwner: m.owner }))
vi.mock("@/lib/sandbox/service", () => ({
  SandboxError: m.SandboxError,
  getSandboxOverview: m.getOverview,
  configureSandbox: m.configure,
  copyProductionToSandbox: m.copy,
  createChange: m.createChange,
  submitChange: m.submitChange,
  decideChange: m.decideChange,
  promoteChange: m.promoteChange,
  rollbackChange: m.rollbackChange,
  getChangeDetail: m.getChangeDetail,
}))

import * as rootRoute from "@/app/api/sandbox/route"
import * as copyRoute from "@/app/api/sandbox/copy/route"
import * as changesRoute from "@/app/api/sandbox/changes/route"
import * as changeItemRoute from "@/app/api/sandbox/changes/[id]/route"
import * as submitRoute from "@/app/api/sandbox/changes/[id]/submit/route"
import * as decideRoute from "@/app/api/sandbox/changes/[id]/decide/route"
import * as promoteRoute from "@/app/api/sandbox/changes/[id]/promote/route"
import * as rollbackRoute from "@/app/api/sandbox/changes/[id]/rollback/route"

const allowed = {
  ok: true,
  ctx: { tenantRole: "tenant_admin" },
  session: { userId: 7, name: "Ada", email: "ada@ent.test" },
}
const denied = { ok: false, status: 403, reason: "Insufficient tenant privileges" }
const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://t.test/api/sandbox", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }) as any
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.resetAllMocks()
  m.admin.mockResolvedValue(allowed)
  m.owner.mockResolvedValue(allowed)
})

describe("permissions", () => {
  it("denies every endpoint when the guard rejects, without touching the service", async () => {
    m.admin.mockResolvedValue(denied)
    m.owner.mockResolvedValue(denied)
    expect((await rootRoute.GET()).status).toBe(403)
    expect((await rootRoute.POST(req("POST", {}))).status).toBe(403)
    expect((await copyRoute.POST(req("POST", {}))).status).toBe(403)
    expect((await changesRoute.GET()).status).toBe(403)
    expect((await changesRoute.POST(req("POST", {}))).status).toBe(403)
    expect((await submitRoute.POST(req("POST"), params("1"))).status).toBe(403)
    expect((await decideRoute.POST(req("POST", { action: "approve" }), params("1"))).status).toBe(403)
    expect((await promoteRoute.POST(req("POST", {}), params("1"))).status).toBe(403)
    expect((await rollbackRoute.POST(req("POST", {}), params("1"))).status).toBe(403)
    for (const fn of [m.configure, m.copy, m.createChange, m.submitChange, m.decideChange, m.promoteChange, m.rollbackChange]) {
      expect(fn).not.toHaveBeenCalled()
    }
  })

  it("promote and rollback require tenant OWNER, not merely admin", async () => {
    // owner guard is the one wired for these routes
    m.owner.mockResolvedValue(denied)
    expect((await promoteRoute.POST(req("POST", {}), params("1"))).status).toBe(403)
    expect((await rollbackRoute.POST(req("POST", {}), params("1"))).status).toBe(403)
    expect(m.promoteChange).not.toHaveBeenCalled()
    expect(m.rollbackChange).not.toHaveBeenCalled()
  })
})

describe("overview & configure", () => {
  it("returns the overview and configures the environment", async () => {
    m.getOverview.mockResolvedValue({ environment: { id: 1 }, changes: [], isolated: true })
    const res = await rootRoute.GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ isolated: true })

    m.configure.mockResolvedValue({ id: 1, schema: "sbx" })
    const cfg = await rootRoute.POST(req("POST", { schema: "sbx", connectionRef: "conn-sbx", region: "eu" }))
    expect(cfg.status).toBe(200)
    expect(m.configure).toHaveBeenCalledWith(
      { schema: "sbx", connectionRef: "conn-sbx", region: "eu" },
      { userId: 7, name: "Ada", email: "ada@ent.test" },
    )
  })

  it("maps a non-enterprise / isolation SandboxError to its status and code", async () => {
    m.configure.mockRejectedValue(new m.SandboxError("Enterprise plan required", "NOT_ENTERPRISE", 403))
    const res = await rootRoute.POST(req("POST", {}))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "NOT_ENTERPRISE" })
  })
})

describe("sanitized copy", () => {
  it("passes the Idempotency-Key header and acting operator", async () => {
    m.copy.mockResolvedValue({ replayed: false, copied: 5, redacted: 2 })
    const res = await copyRoute.POST(req("POST", {}, { "idempotency-key": "cp-1" }))
    expect(res.status).toBe(200)
    expect(m.copy).toHaveBeenCalledWith({ userId: 7, name: "Ada", email: "ada@ent.test" }, "cp-1")
  })

  it("falls back to a body idempotencyKey and defaults to null", async () => {
    m.copy.mockResolvedValue({ replayed: true })
    await copyRoute.POST(req("POST", { idempotencyKey: "cp-2" }))
    expect(m.copy.mock.calls[0][1]).toBe("cp-2")
    m.copy.mockResolvedValue({ replayed: false })
    await copyRoute.POST(req("POST", {}))
    expect(m.copy.mock.calls[1][1]).toBeNull()
  })
})

describe("change lifecycle", () => {
  it("creates a draft change (201) and ignores a body actor", async () => {
    m.createChange.mockResolvedValue({ id: 3, status: "draft" })
    const res = await changesRoute.POST(req("POST", { title: "T", changes: { theme: "dark" }, userId: 999 }))
    expect(res.status).toBe(201)
    expect(m.createChange).toHaveBeenCalledWith(
      { title: "T", changes: { theme: "dark" } },
      { userId: 7, name: "Ada", email: "ada@ent.test" },
    )
  })

  it("validates the change id before hitting the service", async () => {
    for (const id of ["abc", "0", "-1", "1.5"]) {
      expect((await changeItemRoute.GET(req("GET"), params(id))).status).toBe(400)
      expect((await submitRoute.POST(req("POST"), params(id))).status).toBe(400)
      expect((await promoteRoute.POST(req("POST", {}), params(id))).status).toBe(400)
      expect((await rollbackRoute.POST(req("POST", {}), params(id))).status).toBe(400)
    }
    expect(m.submitChange).not.toHaveBeenCalled()
    expect(m.promoteChange).not.toHaveBeenCalled()
  })

  it("requires a valid decide action", async () => {
    expect((await decideRoute.POST(req("POST", {}), params("1"))).status).toBe(400)
    expect((await decideRoute.POST(req("POST", { action: "maybe" }), params("1"))).status).toBe(400)
    expect(m.decideChange).not.toHaveBeenCalled()

    m.decideChange.mockResolvedValue({ id: 1, status: "approved" })
    const ok = await decideRoute.POST(req("POST", { action: "approve", comment: "lgtm" }), params("1"))
    expect(ok.status).toBe(200)
    expect(m.decideChange).toHaveBeenCalledWith(1, "approve", expect.anything(), { isAdmin: true, comment: "lgtm" })
  })

  it("promotes with idempotency and maps a denied/stale promotion to its code", async () => {
    m.promoteChange.mockResolvedValue({ change: { id: 1, status: "promoted" }, deployStatus: "deployed" })
    const ok = await promoteRoute.POST(req("POST", {}, { "idempotency-key": "pr-1" }), params("1"))
    expect(ok.status).toBe(200)
    expect(m.promoteChange).toHaveBeenCalledWith(1, expect.anything(), "pr-1")

    m.promoteChange.mockRejectedValue(new m.SandboxError("Re-review required", "STALE_APPROVAL", 409))
    const stale = await promoteRoute.POST(req("POST", {}), params("1"))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: "STALE_APPROVAL" })

    m.promoteChange.mockRejectedValue(new m.SandboxError("Not approved", "NOT_APPROVED", 409))
    expect((await promoteRoute.POST(req("POST", {}), params("1"))).status).toBe(409)
  })

  it("rolls back with idempotency and surfaces the rollback path result", async () => {
    m.rollbackChange.mockResolvedValue({ change: { id: 1, status: "rolled_back" }, deployStatus: "rolled_back" })
    const res = await rollbackRoute.POST(req("POST", {}, { "idempotency-key": "rb-1" }), params("1"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ deployStatus: "rolled_back" })
    expect(m.rollbackChange).toHaveBeenCalledWith(1, expect.anything(), "rb-1")
  })

  it("returns full change detail (diff / approver / deploy state)", async () => {
    m.getChangeDetail.mockResolvedValue({ id: 1, diff: [], approver: null, deployStatus: "not_deployed" })
    const res = await changeItemRoute.GET(req("GET"), params("1"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ change: { deployStatus: "not_deployed" } })
  })
})

describe("unexpected failures", () => {
  it("maps a non-SandboxError to a 500 without leaking the message", async () => {
    m.createChange.mockRejectedValue(new Error("db exploded"))
    const res = await changesRoute.POST(req("POST", { title: "T" }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Failed to create change" })
  })
})
