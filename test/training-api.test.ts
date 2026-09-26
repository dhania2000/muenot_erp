import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Spec38 (#230-233) — training route handlers: permission gates, server-derived
 * employee/tenant scope (the body can never pick another employee or tenant),
 * validation, idempotency-key pass-through, evidence capture and error mapping.
 * The store is mocked; tenant predicates live in the store.
 */

const m = vi.hoisted(() => {
  class TrainingError extends Error {
    status: number
    constructor(message: string, status = 400) {
      super(message)
      this.status = status
    }
  }
  return {
    TrainingError,
    session: vi.fn(),
    moduleAction: vi.fn(),
    resolveEmployee: vi.fn(),
    store: {
      requireEmployee: vi.fn(),
      acknowledgePolicy: vi.fn(),
      publishPolicyVersion: vi.fn(),
      getPolicyDetail: vi.fn(),
      listPolicies: vi.fn(),
      createPolicy: vi.fn(),
      listPolicyRoster: vi.fn(),
      listPolicyAcknowledgments: vi.fn(),
      assignCourse: vi.fn(),
      getMediaAccessUrl: vi.fn(),
      listMedia: vi.fn(),
      registerMedia: vi.fn(),
      uploadTrainingMedia: vi.fn(),
      listMyCertificates: vi.fn(),
      markLessonComplete: vi.fn(),
    },
  }
})

vi.mock("server-only", () => ({}))
vi.mock("@/lib/auth", () => ({ getSession: m.session }))
vi.mock("@/lib/api-auth", () => ({ requireModuleAction: m.moduleAction }))
vi.mock("@/lib/knowledge-base", () => ({ resolveEmployee: m.resolveEmployee }))
vi.mock("@/lib/training/store", () => ({ ...m.store, TrainingError: m.TrainingError }))

const ackRoute = await import("@/app/api/hr/training/policies/[id]/acknowledge/route")
const policyRoute = await import("@/app/api/hr/training/policies/[id]/route")
const policiesRoute = await import("@/app/api/hr/training/policies/route")
const rosterRoute = await import("@/app/api/hr/training/policies/[id]/roster/route")
const assignRoute = await import("@/app/api/hr/training/courses/[id]/assign/route")
const mediaRoute = await import("@/app/api/hr/training/media/route")
const mediaItemRoute = await import("@/app/api/hr/training/media/[id]/route")
const certRoute = await import("@/app/api/hr/training/certificates/route")

const SESSION = { userId: 7, name: "Asha", role: "user" }
const EMP = { id: 70, employee_name: "Asha" }

const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/x", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const ctx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) })
const storeCalls = () => Object.values(m.store).reduce((n, f) => n + f.mock.calls.length, 0)

beforeEach(() => {
  vi.clearAllMocks()
  m.session.mockResolvedValue(SESSION)
  m.moduleAction.mockResolvedValue(SESSION)
  m.store.requireEmployee.mockResolvedValue(EMP)
  m.resolveEmployee.mockResolvedValue(EMP)
})

describe("permissions", () => {
  it("unauthenticated learners are rejected before the store", async () => {
    m.session.mockResolvedValue(null)
    expect((await ackRoute.POST(req("POST", {}), ctx(1))).status).toBe(403)
    expect((await certRoute.GET()).status).toBe(403)
    expect((await mediaItemRoute.GET(req("GET"), ctx(1))).status).toBe(403)
    expect(storeCalls()).toBe(0)
  })
  it("management endpoints require an HR grant", async () => {
    m.moduleAction.mockResolvedValue(null)
    expect((await policyRoute.PATCH(req("PATCH", { title: "T", body: "B" }), ctx(1))).status).toBe(403)
    expect((await policiesRoute.POST(req("POST", { title: "T", body: "B" }))).status).toBe(403)
    expect((await rosterRoute.GET(req("GET"), ctx(1))).status).toBe(403)
    expect((await assignRoute.POST(req("POST", { roles: ["all"] }), ctx(1))).status).toBe(403)
    expect((await mediaRoute.POST(req("POST", { storage_key: "k" }))).status).toBe(403)
    expect((await mediaRoute.GET()).status).toBe(403)
    expect(storeCalls()).toBe(0)
    expect(m.moduleAction).toHaveBeenCalledWith("hr", "update")
  })
})

describe("policy acknowledgment", () => {
  it("uses the session's employee and captures evidence; ignores body identity", async () => {
    m.store.acknowledgePolicy.mockResolvedValue({ replayed: false, version: 2 })
    const res = await ackRoute.POST(
      req("POST", { version: 2, employee_id: 999, tenant_id: 5 }, {
        "idempotency-key": "ack-1",
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
        "user-agent": "UA/1",
      }),
      ctx(4),
    )
    expect(res.status).toBe(200)
    const [policyId, input, session, employee] = m.store.acknowledgePolicy.mock.calls[0]
    expect(policyId).toBe(4)
    expect(input).toEqual({
      evidence: { ip: "203.0.113.9", userAgent: "UA/1" },
      idempotencyKey: "ack-1",
      readVersion: 2,
    })
    expect(session).toBe(SESSION)
    expect(employee).toBe(EMP)
  })
  it("a stale read version surfaces as 409", async () => {
    m.store.acknowledgePolicy.mockRejectedValue(new m.TrainingError("Policy was updated", 409))
    const res = await ackRoute.POST(req("POST", { version: 1 }), ctx(4))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/updated/)
  })
  it("users without an employee record cannot acknowledge", async () => {
    m.store.requireEmployee.mockRejectedValue(new m.TrainingError("No employee record", 403))
    expect((await ackRoute.POST(req("POST", {}), ctx(4))).status).toBe(403)
    expect(m.store.acknowledgePolicy).not.toHaveBeenCalled()
  })
  it("rejects invalid ids", async () => {
    expect((await ackRoute.POST(req("POST", {}), ctx("abc"))).status).toBe(400)
  })
  it("cross-tenant policy ids are not found", async () => {
    m.store.acknowledgePolicy.mockRejectedValue(new m.TrainingError("Policy not found", 404))
    expect((await ackRoute.POST(req("POST", {}), ctx(999))).status).toBe(404)
  })
})

describe("policy update", () => {
  it("validates before publishing", async () => {
    const res = await policyRoute.PATCH(req("PATCH", { title: "T", body: "" }), ctx(1))
    expect(res.status).toBe(400)
    expect(m.store.publishPolicyVersion).not.toHaveBeenCalled()
  })
  it("forwards the idempotency key", async () => {
    m.store.publishPolicyVersion.mockResolvedValue({ published_version: 3, replayed: false })
    const res = await policyRoute.PATCH(req("PATCH", { title: "T", body: "B" }, { "idempotency-key": "pub-1" }), ctx(1))
    expect(res.status).toBe(200)
    expect(m.store.publishPolicyVersion.mock.calls[0][3]).toBe("pub-1")
  })
  it("maps unexpected store errors to a generic 500", async () => {
    m.store.publishPolicyVersion.mockRejectedValue(new Error("ER_LOCK: secret table detail"))
    const res = await policyRoute.PATCH(req("PATCH", { title: "T", body: "B" }), ctx(1))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Internal error")
  })
})

describe("reassignment", () => {
  it("passes roles, numeric employee ids, reassign flag and key", async () => {
    m.store.assignCourse.mockResolvedValue({ created: 0, reassigned: 2 })
    await assignRoute.POST(
      req("POST", { roles: ["Driver", ""], employeeIds: [1, "2", "x"], reassign: true }, { "idempotency-key": "as-1" }),
      ctx(3),
    )
    expect(m.store.assignCourse).toHaveBeenCalledWith(
      3,
      { roles: ["Driver"], employeeIds: [1, 2], reassign: true, idempotencyKey: "as-1" },
      SESSION,
    )
  })
})

describe("media", () => {
  it("requires a storage key for JSON registration", async () => {
    expect((await mediaRoute.POST(req("POST", {}))).status).toBe(400)
  })
  it("defaults unknown access to 'assigned'", async () => {
    m.store.registerMedia.mockResolvedValue({ id: 1 })
    await mediaRoute.POST(req("POST", { storage_key: "tenants/1/training/a.mp4", access: "public" }))
    expect(m.store.registerMedia.mock.calls[0][0].access).toBe("assigned")
  })
  it("foreign-tenant storage keys are refused", async () => {
    m.store.registerMedia.mockRejectedValue(new m.TrainingError("storage_key does not belong to this tenant", 403))
    expect((await mediaRoute.POST(req("POST", { storage_key: "tenants/2/x" }))).status).toBe(403)
  })
  it("multipart upload goes through central storage", async () => {
    m.store.uploadTrainingMedia.mockResolvedValue({ id: 2 })
    const form = new FormData()
    form.set("file", new File(["x"], "a.pdf", { type: "application/pdf" }))
    form.set("access", "tenant")
    const res = await mediaRoute.POST(new Request("http://localhost/api/x", { method: "POST", body: form }))
    expect(res.status).toBe(200)
    const [file, opts] = m.store.uploadTrainingMedia.mock.calls[0]
    expect(file.name).toBe("a.pdf")
    expect(opts).toEqual({ access: "tenant", expires_at: null })
  })
  it("expired media returns 410 and unassigned 403", async () => {
    m.store.getMediaAccessUrl.mockRejectedValueOnce(new m.TrainingError("This media has expired", 410))
    expect((await mediaItemRoute.GET(req("GET"), ctx(1))).status).toBe(410)
    m.store.getMediaAccessUrl.mockRejectedValueOnce(new m.TrainingError("No access", 403))
    expect((await mediaItemRoute.GET(req("GET"), ctx(1))).status).toBe(403)
  })
})

describe("certificates", () => {
  it("lists only the session employee's certificates", async () => {
    m.store.listMyCertificates.mockResolvedValue([])
    await certRoute.GET()
    expect(m.store.listMyCertificates).toHaveBeenCalledWith(EMP.id)
  })
})
