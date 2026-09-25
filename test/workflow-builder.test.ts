import { beforeEach, describe, expect, it, vi } from "vitest"
import { analyzeWorkflow, assertPublishable, simulateWorkflow, type PublishContext, type Workflow } from "@/lib/workflows/model"
const mock = vi.hoisted(() => ({ query: vi.fn(), sql: vi.fn(), webhook: vi.fn(), notice: vi.fn(), feature: vi.fn(), audit: vi.fn() }))
vi.mock("@/lib/notification-engine/service", () => ({ enqueueNotification: mock.notice }))
vi.mock("@/lib/db", () => ({ query: mock.query, withTransaction: async (fn: any) => fn({ query: mock.sql }) }))
vi.mock("@/lib/workflows/schema", () => ({ ensureWorkflowSchema: async () => {} }))
vi.mock("@/lib/workflows/webhook", () => ({ deliverWebhook: mock.webhook }))
vi.mock("@/lib/events/schema", () => ({ ensureEventSchema: async () => {} }))
vi.mock("@/lib/platform/feature-guard", () => ({ enforceFeature: mock.feature }))
vi.mock("@/lib/audit-log-store", () => ({ recordAuditLog: mock.audit }))
vi.mock("@/lib/billing/usage-guard", () => ({ meterUsage: () => {} }))
import { advanceWorkflow, publishWorkflow, retryWorkflowRun, rollbackWorkflow, simulateWorkflowRun, startWorkflow } from "@/lib/workflows/engine"

const wf = (over: Partial<Workflow> = {}): Workflow => ({ name: "Lead follow-up", description: "", module: "sales_leads", trigger: "manual", conditions: { logic: "AND", children: [] }, actions: [{ type: "update", field: "priority", value: "High" }], elseActions: [], ...over })
const ctx = (over: Partial<PublishContext> = {}): PublishContext => ({ actorId: 2, webhookTargets: ["crm"], emailConfigured: true, whatsappConfigured: true, activeMembers: [2, 4, 5], adminMembers: [2, 4], ...over })
const writes = () => mock.sql.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE)/.test(sql))
let def: any, run: any

beforeEach(() => {
  vi.clearAllMocks()
  mock.feature.mockResolvedValue({ ok: true })
  mock.query.mockResolvedValue([{ id: 2 }])
  vi.stubEnv("WORKFLOW_WEBHOOK_TARGETS", JSON.stringify({ "7": { crm: "https://hooks.example/crm" } }))
  def = { id: 5, tenant_id: 7, enabled: 0, status: "draft", version: 2, published_version: null, definition: wf() }
  run = { id: 8, tenant_id: 7, record_id: 20, requested_by: 2, cursor: 0, status: "queued", attempts: 0, snapshot: wf() }
  mock.sql.mockImplementation(async (sql: string, args: any[] = []) => {
    if (sql.includes("FROM users") && sql.includes("IN (")) return [[{ id: 4, tenant_role: "tenant_admin" }, { id: 5, tenant_role: "member" }]]
    if (sql.includes("FROM users")) return [[{ id: 2 }]]
    if (sql.includes("FROM erp_workflows WHERE tenant_id=? AND id=?")) return [args[0] === 7 ? [def] : []]
    if (sql.includes("COUNT(*)")) return [[{ n: 0 }]]
    if (sql.includes("FROM erp_workflow_versions")) return [args[0] === 7 && args[2] === 1 ? [{ definition: wf({ name: "Old" }) }] : []]
    if (sql.includes("SELECT * FROM erp_workflow_runs")) return [[run]]
    if (sql.includes("available_at<=UTC_TIMESTAMP")) return [[{ id: 8 }]]
    if (sql.includes("FROM sales_leads")) return [args[0] === 7 ? [{ id: 20, tenant_id: 7, priority: "Low" }] : []]
    return [[]]
  })
})

describe("static analysis", () => {
  it("detects event re-publish cycles and task self-creation", () => {
    const loop = wf({ trigger: "event", eventType: "deal.won", actions: [{ type: "update", field: "priority", value: "High" }] })
    const issues = analyzeWorkflow(wf({ module: "workflow_tasks", actions: [{ type: "create", title: "t", description: "", userId: 4 }] }), ctx())
    expect(issues.some(i => i.code === "cycle")).toBe(true)
    expect(analyzeWorkflow(loop, ctx()).every(i => i.code !== "cycle" || i.severity === "error")).toBe(true)
  })
  it("blocks unavailable webhook destinations and disconnected WhatsApp", () => {
    expect(() => assertPublishable(wf({ actions: [{ type: "webhook", target: "erp" }] }), ctx())).toThrow("not configured")
    expect(() => assertPublishable(wf({ actions: [{ type: "whatsapp", phone: "+15550100", message: "hi" }] }), ctx({ whatsappConfigured: false }))).toThrow("WhatsApp")
  })
  it("enforces approver and recipient permissions", () => {
    expect(() => assertPublishable(wf({ actions: [{ type: "approval", userId: 5, message: "ok" }] }), ctx())).toThrow("tenant admin")
    expect(() => assertPublishable(wf({ actions: [{ type: "notify", userId: 99, message: "x" }] }), ctx())).toThrow("not an active member")
  })
  it("simulates the else branch and stops at a blocked step", () => {
    const w = wf({ conditions: { logic: "AND", children: [{ field: "priority", op: "eq", value: "High" }] }, elseActions: [{ type: "delay", seconds: 60 }, { type: "webhook", target: "nope" }, { type: "notify", userId: 4, message: "x" }] })
    const sim = simulateWorkflow(w, { priority: "Low" }, ctx(), 0)
    expect(sim.branch).toBe("else")
    expect(sim.steps.map(s => s.outcome)).toEqual(["waits", "blocked"])
    expect(sim.completes).toBe(false)
  })
})

describe("draft / publish / version / rollback", () => {
  it("never runs an unpublished draft", async () => {
    def.enabled = 1
    await expect(startWorkflow(7, 2, 5, 20, "request-key-1")).rejects.toThrow("not published")
    expect(writes()).toHaveLength(0)
  })
  it("publishes with entitlement check, audit and is idempotent", async () => {
    await publishWorkflow(7, 2, 5, 2)
    expect(mock.feature).toHaveBeenCalledWith(7, "automation.workflows", { usage: 0 })
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("status='published'"), [7, 5])
    expect(mock.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "workflow.publish", context: expect.objectContaining({ tenantId: 7 }) }))
    Object.assign(def, { status: "published", enabled: 1, published_version: 2 }); vi.clearAllMocks()
    expect((await publishWorkflow(7, 2, 5)).unchanged).toBe(true)
    expect(writes()).toHaveLength(0)
    expect(mock.audit).not.toHaveBeenCalled()
  })
  it("rejects publish when the plan lacks the feature (402) or the version is stale (409)", async () => {
    mock.feature.mockResolvedValue({ ok: false, reason: "Upgrade required" })
    await expect(publishWorkflow(7, 2, 5)).rejects.toMatchObject({ status: 402 })
    expect(writes()).toHaveLength(0)
    await expect(publishWorkflow(7, 2, 5, 1)).rejects.toMatchObject({ status: 409 })
  })
  it("refuses to publish an unsafe definition", async () => {
    def.definition = wf({ actions: [{ type: "webhook", target: "unknown" }] })
    await expect(publishWorkflow(7, 2, 5)).rejects.toThrow("not configured")
    expect(writes()).toHaveLength(0)
  })
  it("rolls back by appending a new version, never rewriting history", async () => {
    const result = await rollbackWorkflow(7, 2, 5, 1)
    expect(result).toMatchObject({ version: 3, from: 1, published: false })
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO erp_workflow_versions"), [7, 5, 3, "Old", "", expect.any(String), 2])
    expect(writes().some(([sql]) => sql.includes("DELETE"))).toBe(false)
    expect(mock.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "workflow.rollback" }))
  })
  it("scopes every mutation to the session tenant (cross-tenant ids are not found)", async () => {
    await expect(publishWorkflow(8, 2, 5)).rejects.toMatchObject({ status: 404 })
    await expect(rollbackWorkflow(8, 2, 5, 1)).rejects.toMatchObject({ status: 404 })
    await expect(simulateWorkflowRun(8, 2, wf(), 20)).rejects.toMatchObject({ status: 404 })
    expect(writes()).toHaveLength(0)
  })
  it("runs the published snapshot while a newer draft is pending", async () => {
    Object.assign(def, { enabled: 1, status: "published", version: 2, published_version: 1, definition: wf({ name: "Draft" }) })
    mock.sql.mockImplementation(async (sql: string, args: any[] = []) => {
      if (sql.includes("FROM users")) return [[{ id: 2 }]]
      if (sql.includes("FROM erp_workflows")) return [[def]]
      if (sql.includes("FROM erp_workflow_versions")) return [[{ definition: wf({ name: "Live" }) }]]
      if (sql.includes("FROM sales_leads")) return [[{ id: 20 }]]
      if (sql.startsWith("INSERT INTO erp_workflow_runs")) return [{ insertId: 30 }]
      return [[]]
    })
    await startWorkflow(7, 2, 5, 20, "request-key-2")
    const insert = mock.sql.mock.calls.find(([sql]) => sql.startsWith("INSERT INTO erp_workflow_runs"))!
    expect(JSON.parse(insert[1][2]).name).toBe("Live")
  })
})

describe("simulation and execution", () => {
  it("simulation reads only", async () => {
    const out = await simulateWorkflowRun(7, 2, wf(), 20)
    expect(out.simulation?.matched).toBe(true)
    expect(writes()).toHaveLength(0)
    expect(mock.webhook).not.toHaveBeenCalled()
  })
  it("simulation requires a tenant admin", async () => {
    mock.query.mockResolvedValue([])
    await expect(simulateWorkflowRun(7, 9, wf())).rejects.toMatchObject({ status: 403 })
  })
  it("executes an asset assignment and advances atomically", async () => {
    run.snapshot = wf({ actions: [{ type: "asset", assetTag: "LAPTOP-01", userId: 4 }] })
    await advanceWorkflow(8)
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO erp_workflow_asset_actions"), [7, 8, "LAPTOP-01", 4])
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("cursor=cursor+1"), ["queued", null, 8])
  })
  it("blocks a webhook whose destination was removed after publish, without dispatching", async () => {
    run.snapshot = wf({ actions: [{ type: "webhook", target: "crm" }] })
    vi.stubEnv("WORKFLOW_WEBHOOK_TARGETS", "{}")
    await advanceWorkflow(8)
    expect(mock.webhook).not.toHaveBeenCalled()
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("error_code='action_unavailable'"), [1, 8])
  })
  it("allows manual retry only for locally rolled-back failures", async () => {
    run.status = "failed"; run.error_code = "action_failed"
    await retryWorkflowRun(7, 2, 8)
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("status='queued',attempts=0"), [7, 8])
    vi.clearAllMocks()
    run.error_code = "webhook_delivery_uncertain"
    await expect(retryWorkflowRun(7, 2, 8)).rejects.toThrow("cannot be retried safely")
    expect(writes()).toHaveLength(0)
  })
})
